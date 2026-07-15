import { describe, expect, it, vi } from "vitest";
import type {
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
} from "discord.js";
import { MessageFlags } from "discord.js";
import {
  acknowledgeComponentReply,
  publishComponentReply,
  replyNotice,
} from "./interactions.js";

describe("interaction acknowledgements", () => {
  it("edits a deferred reply instead of creating a follow-up", async () => {
    const editReply = vi.fn<(options: unknown) => Promise<void>>().mockResolvedValue();
    const followUp = vi.fn<(options: unknown) => Promise<void>>().mockResolvedValue();
    const interaction = {
      deferred: true,
      replied: false,
      editReply,
      followUp,
      reply: vi.fn<(options: unknown) => Promise<void>>().mockResolvedValue(),
    } as unknown as ModalSubmitInteraction;

    await replyNotice(interaction, "Queued", "The action was queued.", "success");

    expect(followUp).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledOnce();
    expect(editReply.mock.calls[0]?.[0]).toEqual({
      content: "**Queued**\nThe action was queued.",
      components: [],
    });
    expect(editReply.mock.calls[0]?.[0]).not.toHaveProperty("flags");
  });

  it("preserves a Components V2 acknowledgement and omits flags on edit", async () => {
    const reply = vi.fn<(options: unknown) => Promise<void>>().mockResolvedValue();
    const editReply = vi.fn<(options: unknown) => Promise<void>>().mockResolvedValue();
    const followUp = vi.fn<(options: unknown) => Promise<void>>().mockResolvedValue();
    const interaction = {
      deferred: false,
      replied: false,
      reply,
      editReply,
      followUp,
    } as unknown as ChatInputCommandInteraction;

    await acknowledgeComponentReply(interaction);
    await replyNotice(interaction, "Created", "The giveaway was created.", "success");

    expect(reply).toHaveBeenCalledOnce();
    expect(reply.mock.calls[0]?.[0]).toHaveProperty("flags");
    expect(editReply).toHaveBeenCalledOnce();
    expect(editReply.mock.calls[0]?.[0]).toHaveProperty("components");
    expect(editReply.mock.calls[0]?.[0]).not.toHaveProperty("flags");
    expect(followUp).not.toHaveBeenCalled();
  });

  it("publishes a successful list after its private acknowledgement", async () => {
    const followUp = vi.fn<(options: unknown) => Promise<void>>().mockResolvedValue();
    const deleteReply = vi.fn<() => Promise<void>>().mockResolvedValue();
    const components = [{ type: 17 }];
    const interaction = {
      deferred: false,
      replied: true,
      followUp,
      deleteReply,
    } as unknown as ChatInputCommandInteraction;

    await publishComponentReply(interaction, components as never);

    expect(followUp).toHaveBeenCalledOnce();
    const payload = followUp.mock.calls[0]?.[0] as { flags: number };
    expect(payload.flags & MessageFlags.Ephemeral).toBe(0);
    expect(deleteReply).toHaveBeenCalledOnce();
  });
});
