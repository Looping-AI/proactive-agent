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
  name: "Example Echo Agent",
  description:
    "Reference remote A2A agent for looping-gateway. Verifies the gateway " +
    "identity JWT and echoes the caller's message.",
  version: "0.1.0",
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "echo",
      name: "Echo",
      description: "Echoes the caller's message back, greeting them by name.",
      tags: ["chat", "echo"]
    }
  ]
};
