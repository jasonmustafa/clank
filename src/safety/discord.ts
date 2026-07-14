import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type Client,
} from "discord.js";
import { type Approval, type ApprovalMessenger, ApprovalService } from "./index.js";

const PREFIX = "clank-approval";

export class DiscordApprovalMessenger implements ApprovalMessenger {
  constructor(private readonly client: Client) {}

  async send(approval: Approval): Promise<string> {
    const channel = await this.#channel(approval.channelId);
    const message = await channel.send(approvalMessage(approval));
    return message.id;
  }

  async update(approval: Approval): Promise<void> {
    if (approval.messageId === undefined) return;
    const channel = await this.#channel(approval.channelId);
    const message = await channel.messages.fetch(approval.messageId);
    await message.edit(approvalMessage(approval));
  }

  async #channel(channelId: string): Promise<ApprovalChannel> {
    const channel: unknown = await this.client.channels.fetch(channelId);
    if (!isApprovalChannel(channel)) throw new Error(`Approval channel ${channelId} is unavailable`);
    return channel;
  }
}

export function attachApprovalInteractionRouter(client: Client, approvals: ApprovalService): void {
  client.on("interactionCreate", (interaction) => {
    if (!interaction.isButton() || !interaction.customId.startsWith(`${PREFIX}:`)) return;
    void handleApprovalButton(interaction, approvals);
  });
}

async function handleApprovalButton(interaction: ButtonInteraction, approvals: ApprovalService): Promise<void> {
  const [, id, decision] = interaction.customId.split(":");
  if (id === undefined || (decision !== "approve" && decision !== "deny")) return;
  const accepted = await approvals.decide(id, interaction.user.id, decision === "approve");
  await interaction.reply({ content: accepted ? "Approved." : decision === "deny" && approvals.get(id)?.status === "denied" ? "Denied." : "You cannot approve this request, or it has expired.", ephemeral: true });
}

interface ApprovalChannel {
  send(options: ReturnType<typeof approvalMessage>): Promise<{ id: string }>;
  messages: { fetch(id: string): Promise<{ edit(options: ReturnType<typeof approvalMessage>): Promise<unknown> }> };
}

function isApprovalChannel(value: unknown): value is ApprovalChannel {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { send?: unknown; messages?: { fetch?: unknown } };
  return typeof candidate.send === "function" && typeof candidate.messages?.fetch === "function";
}

function approvalMessage(approval: Approval) {
  const pending = approval.status === "pending";
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:${approval.id}:approve`).setLabel("Approve").setStyle(ButtonStyle.Danger).setDisabled(!pending),
    new ButtonBuilder().setCustomId(`${PREFIX}:${approval.id}:deny`).setLabel("Deny").setStyle(ButtonStyle.Secondary).setDisabled(!pending),
  );
  return {
    content: `**Clank confirmation: ${approval.status}**\n${approval.summary}\nRequester: <@${approval.requesterId}>\nExpires: <t:${String(Math.floor(approval.expiresAt / 1_000))}:R>`,
    components: [row],
  };
}
