import { NETWORK } from "../lib/guard/network.ts";

export function rpcHostname(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).hostname || rpcUrl;
  } catch (error) {
    if (error instanceof TypeError) return rpcUrl;
    throw error;
  }
}

export const EVALUATE_ENDPOINTS_GUIDE_PATH = "/docs/guides/evaluating-rpc-endpoints.md";
export const EVALUATE_ENDPOINTS_LABEL = "Evaluating third-party endpoints";

export function ConfigureNetworkContext({
  networkName = NETWORK.name,
  rpcUrl = NETWORK.rpcUrl,
}: {
  networkName?: string;
  rpcUrl?: string;
}) {
  return (
    <div className="configure-network-context" aria-label="Configured network">
      <span className="pill" data-testid="configure-network-name">
        {networkName}
      </span>
      <code className="configure-network-host" data-testid="configure-rpc-hostname" title={rpcUrl}>
        {rpcHostname(rpcUrl)}
      </code>
      <a
        href={EVALUATE_ENDPOINTS_GUIDE_PATH}
        className="tiny rpc-checklist-link"
        data-testid="rpc-checklist-link"
        title="Safe checklist for evaluating third-party endpoints"
        target="_blank"
        rel="noopener noreferrer"
        style={{ marginLeft: 8 }}
      >
        {EVALUATE_ENDPOINTS_LABEL}
      </a>
    </div>
  );
}
