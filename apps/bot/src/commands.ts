import {
  ChannelType,
  SlashCommandBuilder,
  type RESTPostAPIApplicationCommandsJSONBody,
} from "discord.js";

export const commandData: RESTPostAPIApplicationCommandsJSONBody[] = [
  new SlashCommandBuilder()
    .setName("giveaway")
    .setDescription("Create and manage verifiably random giveaways")
    .setDMPermission(false)
    .addSubcommand((command) =>
      command
        .setName("create")
        .setDescription("Create or schedule a giveaway")
        .addStringOption((option) =>
          option.setName("prize").setDescription("Prize description").setMaxLength(256).setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("duration")
            .setDescription("Examples: 2d3h, 1d 2h, or a Unix end time")
            .setMaxLength(100)
            .setRequired(true),
        )
        .addIntegerOption((option) =>
          option
            .setName("winners")
            .setDescription("Number of winners")
            .setMinValue(1)
            .setRequired(true),
        )
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Where to post the giveaway")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        )
        .addStringOption((option) =>
          option
            .setName("role_prizes")
            .setDescription("Roles awarded to winners, separated by spaces or commas"),
        )
        .addIntegerOption((option) =>
          option
            .setName("required_messages")
            .setDescription("Messages a member must have sent")
            .setMinValue(1),
        )
        .addStringOption((option) =>
          option
            .setName("required_roles")
            .setDescription("Required role mentions or IDs, separated by spaces or commas"),
        )
        .addStringOption((option) =>
          option
            .setName("role_bonus_entries")
            .setDescription("Role bonus pairs, e.g. @role:2, roleId:5"),
        )
        .addStringOption((option) =>
          option
            .setName("start")
            .setDescription("Examples: 2h, 1d3h, or a Unix start time")
            .setMaxLength(100),
        )
        .addUserOption((option) =>
          option.setName("host").setDescription("Person credited as the host"),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("reroll")
        .setDescription("Reroll a completed giveaway")
        .addStringOption((option) =>
          option.setName("message_id").setDescription("Giveaway message ID").setRequired(true),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("end")
        .setDescription("Force-end an active giveaway")
        .addStringOption((option) =>
          option.setName("message_id").setDescription("Giveaway message ID").setRequired(true),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("start")
        .setDescription("Force-start one of your queued giveaways")
        .addStringOption((option) =>
          option
            .setName("giveaway")
            .setDescription("Queued giveaway ID; leave blank to open the picker")
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("delete")
        .setDescription("Delete a giveaway and leave a public tombstone")
        .addStringOption((option) =>
          option.setName("message_id").setDescription("Giveaway message ID").setRequired(true),
        ),
    )
    .addSubcommand((command) =>
      command.setName("queue").setDescription("Show queued giveaways in this server"),
    )
    .addSubcommand((command) =>
      command.setName("list").setDescription("Show active giveaways in this server"),
    )
    .toJSON(),
];
