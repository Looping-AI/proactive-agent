import type { AgentCapabilities, AgentSkill } from "@a2a-js/sdk";

interface AgentManifest {
  name: string;
  description: string;
  version: string;
  capabilities: AgentCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
}

export const manifest: AgentManifest = {
  name: "Example Agent",
  description:
    "Reference remote A2A agent for looping-gateway. Verifies the gateway " +
    "identity JWT, then answers the caller via a Workers-AI tool loop.",
  version: "0.2.1",
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "chat",
      name: "Chat",
      description:
        "Chat with the caller using a Workers-AI model, calling tools when useful.",
      tags: ["chat", "assistant"]
    },
    {
      id: "whoami",
      name: "Who am I",
      description:
        "Report the verified identity of the calling gateway-agent instance (from the gateway JWT) — not the Slack end user.",
      tags: ["identity"]
    }
  ]
};
