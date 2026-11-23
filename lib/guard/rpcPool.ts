import { DEFAULT_FLEET_PROBE_CONCURRENCY } from "./fleet.ts";

export class RpcPool {
  primaryUrl: string;
  fallbackUrls: string[];
  currentUrl: string;
  failureCount: number = 0;
  rtt: number = 0;
  maxConcurrency: number = DEFAULT_FLEET_PROBE_CONCURRENCY;
  private activeRequests: number = 0;
  private healthCheckTimer: any;

  constructor(primaryUrl: string, fallbackUrls: string[], options?: { maxConcurrency?: number }) {
    this.primaryUrl = primaryUrl;
    this.fallbackUrls = fallbackUrls;
    this.currentUrl = primaryUrl;
    if (options?.maxConcurrency) {
      this.maxConcurrency = Math.max(1, options.maxConcurrency);
    }
  }

  async fetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
    const start = Date.now();
    this.activeRequests++;
    try {
      const response = await fetch(`${this.currentUrl}${endpoint}`, options);
      this.rtt = Date.now() - start;

      if (response.status === 429 || response.status === 503) {
        this.handleFailure();
      } else {
        this.failureCount = 0;
      }
      return response;
    } catch (error) {
      this.handleFailure();
      throw error;
    } finally {
      this.activeRequests = Math.max(0, this.activeRequests - 1);
    }
  }

  /**
   * Run operations across an array of items bounded by maxConcurrency.
   * Cancels cleanly on AbortSignal and maintains original item ordering.
   */
  async mapConcurrent<T, R>(
    items: T[],
    fn: (item: T, index: number) => Promise<R>,
    concurrency: number = this.maxConcurrency,
    signal?: AbortSignal,
  ): Promise<R[]> {
    const results: R[] = new Array(items.length);
    const limit = Math.max(1, concurrency);
    let nextIndex = 0;

    const workerCount = Math.min(limit, items.length);
    if (workerCount === 0) return [];

    const workers = Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        if (signal?.aborted) {
          break;
        }
        const index = nextIndex++;
        results[index] = await fn(items[index]!, index);
      }
    });

    await Promise.all(workers);
    return results;
  }

  private handleFailure() {
    this.failureCount++;
    if (this.failureCount >= 3) {
      this.failover();
    }
  }

  private failover() {
    this.failureCount = 0;
    const nextUrl = this.fallbackUrls.shift();
    if (nextUrl) {
      this.fallbackUrls.push(this.currentUrl);
      this.currentUrl = nextUrl;
    }
  }

  startHealthCheck(interval: number = 10000) {
    if (this.healthCheckTimer) clearTimeout(this.healthCheckTimer);
    this.healthCheckTimer = setTimeout(() => {
      this.fetch("/health").catch(() => {});
      this.startHealthCheck(interval);
    }, interval);
  }

  stopHealthCheck() {
    if (this.healthCheckTimer) {
      clearTimeout(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }
}
