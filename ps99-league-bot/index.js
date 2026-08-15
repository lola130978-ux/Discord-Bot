require("dotenv").config();

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder
} = require("discord.js");

const fs = require("fs");
const path = require("path");

const TOKEN = process.env.DISCORD_TOKEN;

// ============================================================
// CONFIG
// ============================================================

const BANK_ROLE_ID = "1532984876826103889";

const PS99_API = "https://ps99.biggamesapi.io/v1";
const ROBLOX_API = "https://users.roblox.com/v1";

const DATA_FILE = path.join(__dirname, "data.json");

if (!TOKEN) {
    console.error("❌ DISCORD_TOKEN is missing from .env");
    process.exit(1);
}

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

// ============================================================
// DATA
// ============================================================

let data = {};

if (fs.existsSync(DATA_FILE)) {
    try {
        data = JSON.parse(
            fs.readFileSync(DATA_FILE, "utf8")
        );
    } catch {
        data = {};
    }
}

function saveData() {
    fs.writeFileSync(
        DATA_FILE,
        JSON.stringify(data, null, 2)
    );
}

function getGuildData(guildId) {
    if (!data[guildId]) {
        data[guildId] = {
            users: [],

            bank: {
                gems: 0,
                items: []
            },

            requests: {}
        };

        saveData();
    }

    // Upgrade older data files automatically
    if (!data[guildId].users) {
        data[guildId].users = [];
    }

    if (!data[guildId].bank) {
        data[guildId].bank = {
            gems: 0,
            items: []
        };
    }

    if (typeof data[guildId].bank.gems !== "number") {
        data[guildId].bank.gems = 0;
    }

    if (!Array.isArray(data[guildId].bank.items)) {
        data[guildId].bank.items = [];
    }

    if (!data[guildId].requests) {
        data[guildId].requests = {};
    }

    return data[guildId];
}

// ============================================================
// PERMISSIONS
// ============================================================

function hasBankRole(interaction) {
    if (!interaction.guild) {
        return false;
    }

    return interaction.member.roles.cache.has(
        BANK_ROLE_ID
    );
}

function denyPermission(interaction) {
    return interaction.reply({
        content:
            "❌ You don't have permission to use this command.",
        ephemeral: true
    });
}

// ============================================================
// API
// ============================================================

async function getJson(url, options = {}) {
    const response = await fetch(url, options);

    let body;

    try {
        body = await response.json();
    } catch {
        body = null;
    }

    if (!response.ok) {
        throw new Error(
            body?.error?.message ||
            body?.message ||
            `HTTP ${response.status}`
        );
    }

    return body;
}

// ============================================================
// ROBLOX USER LOOKUP
// ============================================================

async function findRobloxUser(username) {
    const result = await getJson(
        `${ROBLOX_API}/usernames/users`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                usernames: [username],
                excludeBannedUsers: false
            })
        }
    );

    if (!result.data || result.data.length === 0) {
        return null;
    }

    const user = result.data[0];

    return {
        userId: Number(user.id),
        username: user.name,
        displayName: user.displayName
    };
}

// ============================================================
// GET PLAYER LEAGUE
// ============================================================

async function getPlayerLeague(userId) {
    const response = await fetch(
        `${PS99_API}/leagues/players/${userId}`
    );

    let body;

    try {
        body = await response.json();
    } catch {
        body = null;
    }

    if (response.status === 404) {
        return null;
    }

    if (!response.ok) {
        throw new Error(
            body?.error?.message ||
            `PS99 API returned HTTP ${response.status}`
        );
    }

    if (
        !body ||
        body.status !== "ok" ||
        !body.data
    ) {
        return null;
    }

    return body.data;
}

// ============================================================
// GET LEAGUE RANK
// ============================================================

async function getLeagueDetails(
    leagueName,
    userId
) {
    const result = await getJson(
        `${PS99_API}/leagues/${encodeURIComponent(
            leagueName
        )}`
    );

    if (!result.data) {
        return null;
    }

    const league = result.data;

    const contributions =
        Array.isArray(league.PointContributions)
            ? league.PointContributions
            : [];

    const index =
        contributions.findIndex(
            player =>
                Number(player.UserID) ===
                Number(userId)
        );

    if (index === -1) {
        return null;
    }

    const player =
        contributions[index];

    return {
        leagueName: league.Name,

        leaguePoints:
            Number(player.Points || 0),

        leagueRank:
            index + 1
    };
}

// ============================================================
// CHECK PLAYER
// ============================================================

async function checkPlayer(tracked) {
    const contribution =
        await getPlayerLeague(
            tracked.robloxUserId
        );

    if (!contribution) {
        return {
            status: "NO_LEAGUE_DATA"
        };
    }

    const leagueName =
        contribution.League?.Name;

    if (!leagueName) {
        return {
            status: "NO_LEAGUE"
        };
    }

    const details =
        await getLeagueDetails(
            leagueName,
            tracked.robloxUserId
        );

    if (!details) {
        return {
            status: "NO_LEAGUE_DATA"
        };
    }

    const previousPoints =
        tracked.lastLeaguePoints;

    const previousRank =
        tracked.lastLeagueRank;

    let gain = null;

    if (
        previousPoints !== null &&
        previousPoints !== undefined
    ) {
        gain =
            details.leaguePoints -
            previousPoints;
    }

    let rankChange = null;

    if (
        previousRank !== null &&
        previousRank !== undefined
    ) {
        rankChange =
            previousRank -
            details.leagueRank;
    }

    const result = {
        status: "OK",

        leagueName:
            details.leagueName,

        leaguePoints:
            details.leaguePoints,

        leagueRank:
            details.leagueRank,

        gain,

        rankChange,

        previousPoints,

        previousRank
    };

    tracked.lastLeague =
        details.leagueName;

    tracked.lastLeaguePoints =
        details.leaguePoints;

    tracked.lastLeagueRank =
        details.leagueRank;

    tracked.lastChecked =
        Date.now();

    saveData();

    return result;
}

// ============================================================
// COMMANDS
// ============================================================

const commands = [

    // --------------------------------------------------------
    // TRACKER
    // --------------------------------------------------------

    new SlashCommandBuilder()
        .setName("adduser")
        .setDescription(
            "Track a Roblox player for PS99 League Points"
        )
        .addStringOption(option =>
            option
                .setName("username")
                .setDescription("Roblox username")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("removeuser")
        .setDescription(
            "Stop tracking a Roblox player"
        )
        .addStringOption(option =>
            option
                .setName("username")
                .setDescription("Roblox username")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("users")
        .setDescription(
            "Show all tracked users"
        ),

    new SlashCommandBuilder()
        .setName("check")
        .setDescription(
            "Immediately check all tracked users"
        ),

    new SlashCommandBuilder()
        .setName("factoryreset")
        .setDescription(
            "Remove every tracked PS99 player"
        ),

    // --------------------------------------------------------
    // BANK
    // --------------------------------------------------------

    new SlashCommandBuilder()
        .setName("bank")
        .setDescription(
            "View the League Bank"
        ),

    new SlashCommandBuilder()
        .setName("bankadd")
        .setDescription(
            "Add gems or an item to the League Bank"
        )
        .addStringOption(option =>
            option
                .setName("type")
                .setDescription(
                    "What are you adding?"
                )
                .setRequired(true)
                .addChoices(
                    {
                        name: "Gems",
                        value: "gems"
                    },
                    {
                        name: "Item",
                        value: "item"
                    }
                )
        )
        .addIntegerOption(option =>
            option
                .setName("amount")
                .setDescription(
                    "Amount of gems/items"
                )
                .setMinValue(1)
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("item")
                .setDescription(
                    "Item name (required for items)"
                )
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName("bankremove")
        .setDescription(
            "Remove gems or an item from the League Bank"
        )
        .addStringOption(option =>
            option
                .setName("type")
                .setDescription(
                    "What are you removing?"
                )
                .setRequired(true)
                .addChoices(
                    {
                        name: "Gems",
                        value: "gems"
                    },
                    {
                        name: "Item",
                        value: "item"
                    }
                )
        )
        .addIntegerOption(option =>
            option
                .setName("amount")
                .setDescription(
                    "Amount of gems/items"
                )
                .setMinValue(1)
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("item")
                .setDescription(
                    "Item name (required for items)"
                )
                .setRequired(false)
        ),

    // --------------------------------------------------------
    // REQUESTS
    // --------------------------------------------------------

    new SlashCommandBuilder()
        .setName("request")
        .setDescription(
            "Request gems or items from the League Bank"
        )

].map(command => command.toJSON());

// ============================================================
// REQUEST ID
// ============================================================

function generateRequestId() {
    return (
        Date.now().toString(36) +
        Math.random()
            .toString(36)
            .substring(2, 8)
    );
}

// ============================================================
// FIND OPEN REQUEST
// ============================================================

function getUserOpenRequest(
    guildData,
    discordUserId
) {
    return Object.values(
        guildData.requests
    ).find(
        request =>
            request.userId === discordUserId &&
            request.status === "pending"
    );
}

// ============================================================
// DM OWNERS
// ============================================================

async function notifyOwners(
    guild,
    request
) {
    const role =
        guild.roles.cache.get(
            BANK_ROLE_ID
        );

    if (!role) {
        console.error(
            `❌ Bank role ${BANK_ROLE_ID} not found.`
        );
        return [];
    }

    const ownerIds = [];

    for (
        const member of role.members.values()
    ) {
        try {
            await member.send({
                embeds: [
                    new EmbedBuilder()
                        .setTitle(
                            "🏦 New League Bank Request"
                        )
                        .setDescription(
                            `A member has requested something from the League Bank.`
                        )
                        .addFields(
                            {
                                name: "👤 Discord User",
                                value:
                                    `<@${request.userId}>`
                            },
                            {
                                name: "🎮 Roblox User",
                                value:
                                    request.robloxUsername
                            },
                            {
                                name: "💰 Amount",
                                value:
                                    request.amount
                            },
                            {
                                name: "📝 Reason",
                                value:
                                    request.reason
                            }
                        )
                        .setFooter({
                            text:
                                `Request ID: ${request.id}`
                        })
                ],

                components: [
                    new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId(
                                    `bank_approve_${request.id}`
                                )
                                .setLabel(
                                    "Approve"
                                )
                                .setStyle(
                                    ButtonStyle.Success
                                ),

                            new ButtonBuilder()
                                .setCustomId(
                                    `bank_reject_${request.id}`
                                )
                                .setLabel(
                                    "Reject"
                                )
                                .setStyle(
                                    ButtonStyle.Danger
                                )
                        ]
                ]
            });

            ownerIds.push(member.id);

        } catch (error) {
            console.error(
                `Couldn't DM ${member.user.tag}:`,
                error.message
            );
        }
    }

    return ownerIds;
}

// ============================================================
// BOT READY
// ============================================================

client.once("ready", async () => {

    console.log(
        `✅ Logged in as ${client.user.tag}`
    );

    const rest =
        new REST({
            version: "10"
        }).setToken(TOKEN);

    try {

        await rest.put(
            Routes.applicationCommands(
                client.user.id
            ),
            {
                body: commands
            }
        );

        console.log(
            "✅ Slash commands registered."
        );

    } catch (error) {

        console.error(
            "❌ Failed to register commands:",
            error
        );
    }

    console.log(
        "🏦 League Bank system loaded."
    );

    console.log(
        "🏆 PS99 League Tracker is running."
    );

    console.log(
        "⏰ Checking every 5 minutes."
    );

    startTracker();
});

// ============================================================
// INTERACTION HANDLER
// ============================================================

client.on(
    "interactionCreate",
    async interaction => {

        // ====================================================
        // SLASH COMMANDS
        // ====================================================

        if (
            interaction.isChatInputCommand()
        ) {

            if (!interaction.guildId) {
                return interaction.reply({
                    content:
                        "❌ Use this command inside a server.",
                    ephemeral: true
                });
            }

            const guildData =
                getGuildData(
                    interaction.guildId
                );

            // =================================================
            // ADD USER
            // =================================================

            if (
                interaction.commandName ===
                "adduser"
            ) {

                const username =
                    interaction.options.getString(
                        "username"
                    );

                if (
                    guildData.users.length >= 10
                ) {

                    return interaction.reply({
                        content:
                            "❌ You already have 10 users tracked.",
                        ephemeral: true
                    });
                }

                const alreadyTracked =
                    guildData.users.some(
                        user =>
                            user.username.toLowerCase() ===
                            username.toLowerCase()
                    );

                if (alreadyTracked) {

                    return interaction.reply({
                        content:
                            "❌ That Roblox user is already being tracked.",
                        ephemeral: true
                    });
                }

                await interaction.deferReply();

                try {

                    const robloxUser =
                        await findRobloxUser(
                            username
                        );

                    if (!robloxUser) {

                        return interaction.editReply(
                            `❌ I couldn't find the Roblox user **${username}**.`
                        );
                    }

                    const tracked = {

                        username:
                            robloxUser.username,

                        displayName:
                            robloxUser.displayName,

                        robloxUserId:
                            robloxUser.userId,

                        discordUserId:
                            interaction.user.id,

                        channelId:
                            interaction.channelId,

                        lastLeague:
                            null,

                        lastLeaguePoints:
                            null,

                        lastLeagueRank:
                            null,

                        lastChecked:
                            null
                    };

                    guildData.users.push(
                        tracked
                    );

                    saveData();

                    const result =
                        await checkPlayer(
                            tracked
                        );

                    if (
                        result.status ===
                        "OK"
                    ) {

                        return interaction.editReply(
                            `✅ **${robloxUser.username}** is now being tracked!\n\n` +
                            `🏆 **League:** ${result.leagueName}\n` +
                            `📊 **League Rank:** #${result.leagueRank}\n` +
                            `⭐ **League Points:** ${result.leaguePoints.toLocaleString()}\n\n` +
                            `⏰ I'll check every **5 minutes**.`
                        );
                    }

                    return interaction.editReply(
                        `✅ **${robloxUser.username}** was added!\n\n` +
                        `🕐 No active League contribution data is available yet.\n\n` +
                        `I'll automatically keep checking every **5 minutes**.`
                    );

                } catch (error) {

                    console.error(
                        "Add user error:",
                        error
                    );

                    return interaction.editReply(
                        `❌ Roblox user was found, but I couldn't read their PS99 League data yet.\n\n` +
                        `I'll keep checking automatically.`
                    );
                }
            }

            // =================================================
            // REMOVE USER
            // =================================================

            if (
                interaction.commandName ===
                "removeuser"
            ) {

                const username =
                    interaction.options.getString(
                        "username"
                    );

                const before =
                    guildData.users.length;

                guildData.users =
                    guildData.users.filter(
                        user =>
                            user.username.toLowerCase() !==
                            username.toLowerCase()
                    );

                if (
                    guildData.users.length ===
                    before
                ) {

                    return interaction.reply({
                        content:
                            "❌ That user isn't being tracked.",
                        ephemeral: true
                    });
                }

                saveData();

                return interaction.reply(
                    `✅ Stopped tracking **${username}**.`
                );
            }

            // =================================================
            // USERS
            // =================================================

            if (
                interaction.commandName ===
                "users"
            ) {

                if (
                    guildData.users.length ===
                    0
                ) {

                    return interaction.reply(
                        "📭 No users are being tracked."
                    );
                }

                const output =
                    guildData.users
                        .map(
                            (user, index) => {

                                const league =
                                    user.lastLeague ||
                                    "No active League data";

                                const rank =
                                    user.lastLeagueRank
                                        ? `#${user.lastLeagueRank}`
                                        : "Unknown";

                                const points =
                                    user.lastLeaguePoints !== null
                                        ? user.lastLeaguePoints.toLocaleString()
                                        : "Unknown";

                                return (
                                    `**${index + 1}. ${user.username}**\n` +
                                    `🏆 League: **${league}**\n` +
                                    `📊 League Rank: **${rank}**\n` +
                                    `⭐ League Points: **${points}**`
                                );
                            }
                        )
                        .join("\n\n");

                return interaction.reply(
                    `🏆 **PS99 League Tracker**\n\n${output}`
                );
            }

            // =================================================
            // MANUAL CHECK
            // =================================================

            if (
                interaction.commandName ===
                "check"
            ) {

                await interaction.deferReply();

                if (
                    guildData.users.length ===
                    0
                ) {

                    return interaction.editReply(
                        "📭 No users are being tracked."
                    );
                }

                const results = [];

                for (
                    const user of
                    guildData.users
                ) {

                    try {

                        const result =
                            await checkPlayer(
                                user
                            );

                        if (
                            result.status !==
                            "OK"
                        ) {

                            results.push(
                                `👤 **${user.username}**\n` +
                                `🕐 No active League contribution data found.`
                            );

                            continue;
                        }

                        let gainText =
                            "First check";

                        if (
                            result.gain !== null
                        ) {

                            gainText =
                                result.gain > 0
                                    ? `+${result.gain.toLocaleString()}`
                                    : result.gain.toLocaleString();
                        }

                        results.push(
                            `👤 **${user.username}**\n` +
                            `🏆 League: **${result.leagueName}**\n` +
                            `📊 League Rank: **#${result.leagueRank}**\n` +
                            `⭐ League Points: **${result.leaguePoints.toLocaleString()}**\n` +
                            `📈 5m Gain: **${gainText}**`
                        );

                    } catch (error) {

                        console.error(error);

                        results.push(
                            `❌ **${user.username}** — temporary API error.`
                        );
                    }
                }

                return interaction.editReply(
                    results.join("\n\n")
                );
            }

            // =================================================
            // FACTORY RESET
            // =================================================

            if (
                interaction.commandName ===
                "factoryreset"
            ) {

                if (!hasBankRole(interaction)) {
                    return denyPermission(
                        interaction
                    );
                }

                const count =
                    guildData.users.length;

                guildData.users = [];

                saveData();

                return interaction.reply(
                    `🧹 **Factory reset complete.**\n\n` +
                    `Removed **${count}** tracked player(s).\n` +
                    `🏦 The League Bank was **not** changed.`
                );
            }

            // =================================================
            // BANK VIEW
            // =================================================

            if (
                interaction.commandName ===
                "bank"
            ) {

                const bank =
                    guildData.bank;

                let itemsText =
                    "None";

                if (
                    bank.items.length > 0
                ) {
                    itemsText =
                        bank.items
                            .map(
                                item =>
                                    `• **${item.name}** × ${item.amount}`
                            )
                            .join("\n");
                }

                return interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle(
                                "🏦 League Bank"
                            )
                            .addFields(
                                {
                                    name: "💎 Gems",
                                    value:
                                        bank.gems.toLocaleString(),
                                    inline: false
                                },
                                {
                                    name: "📦 Items",
                                    value:
                                        itemsText,
                                    inline: false
                                }
                            )
                    ]
                });
            }

            // =================================================
            // BANK ADD
            // =================================================

            if (
                interaction.commandName ===
                "bankadd"
            ) {

                if (!hasBankRole(interaction)) {
                    return denyPermission(
                        interaction
                    );
                }

                const type =
                    interaction.options.getString(
                        "type"
                    );

                const amount =
                    interaction.options.getInteger(
                        "amount"
                    );

                const itemName =
                    interaction.options.getString(
                        "item"
                    );

                if (
                    type === "item" &&
                    !itemName
                ) {

                    return interaction.reply({
                        content:
                            "❌ You must provide an item name when adding an item.",
                        ephemeral: true
                    });
                }

                if (
                    type === "gems"
                ) {

                    guildData.bank.gems +=
                        amount;

                    saveData();

                    return interaction.reply(
                        `✅ Added **${amount.toLocaleString()} gems** to the League Bank.\n\n` +
                        `💎 New balance: **${guildData.bank.gems.toLocaleString()} gems**`
                    );
                }

                const existing =
                    guildData.bank.items.find(
                        item =>
                            item.name.toLowerCase() ===
                            itemName.toLowerCase()
                    );

                if (existing) {
                    existing.amount +=
                        amount;
                } else {
                    guildData.bank.items.push({
                        name: itemName,
                        amount
                    });
                }

                saveData();

                return interaction.reply(
                    `✅ Added **${amount}x ${itemName}** to the League Bank.`
                );
            }

            // =================================================
            // BANK REMOVE
            // =================================================

            if (
                interaction.commandName ===
                "bankremove"
            ) {

                if (!hasBankRole(interaction)) {
                    return denyPermission(
                        interaction
                    );
                }

                const type =
                    interaction.options.getString(
                        "type"
                    );

                const amount =
                    interaction.options.getInteger(
                        "amount"
                    );

                const itemName =
                    interaction.options.getString(
                        "item"
                    );

                if (
                    type === "item" &&
                    !itemName
                ) {

                    return interaction.reply({
                        content:
                            "❌ You must provide an item name when removing an item.",
                        ephemeral: true
                    });
                }

                if (
                    type === "gems"
                ) {

                    if (
                        amount >
                        guildData.bank.gems
                    ) {

                        return interaction.reply({
                            content:
                                "❌ The League Bank doesn't have enough gems.",
                            ephemeral: true
                        });
                    }

                    guildData.bank.gems -=
                        amount;

                    saveData();

                    return interaction.reply(
                        `✅ Removed **${amount.toLocaleString()} gems** from the League Bank.\n\n` +
                        `💎 New balance: **${guildData.bank.gems.toLocaleString()} gems**`
                    );
                }

                const existing =
                    guildData.bank.items.find(
                        item =>
                            item.name.toLowerCase() ===
                            itemName.toLowerCase()
                    );

                if (
                    !existing ||
                    existing.amount < amount
                ) {

                    return interaction.reply({
                        content:
                            "❌ The League Bank doesn't have enough of that item.",
                        ephemeral: true
                    });
                }

                existing.amount -=
                    amount;

                if (
                    existing.amount <= 0
                ) {

                    guildData.bank.items =
                        guildData.bank.items.filter(
                            item =>
                                item.name.toLowerCase() !==
                                itemName.toLowerCase()
                        );
                }

                saveData();

                return interaction.reply(
                    `✅ Removed **${amount}x ${itemName}** from the League Bank.`
                );
            }

            // =================================================
            // REQUEST
            // =================================================

            if (
                interaction.commandName ===
                "request"
            ) {

                const existing =
                    getUserOpenRequest(
                        guildData,
                        interaction.user.id
                    );

                if (existing) {

                    return interaction.reply({
                        content:
                            "❌ You already have an open League Bank request. Wait for it to be approved or rejected before making another.",
                        ephemeral: true
                    });
                }

                const modal =
                    new ModalBuilder()
                        .setCustomId(
                            "league_bank_request"
                        )
                        .setTitle(
                            "🏦 League Bank Request"
                        );

                const reason =
                    new TextInputBuilder()
                        .setCustomId(
                            "reason"
                        )
                        .setLabel(
                            "Reason for request"
                        )
                        .setStyle(
                            TextInputStyle.Paragraph
                        )
                        .setPlaceholder(
                            "Why do you need this?"
                        )
                        .setRequired(true)
                        .setMaxLength(1000);

                const amount =
                    new TextInputBuilder()
                        .setCustomId(
                            "amount"
                        )
                        .setLabel(
                            "Amount of gems/items"
                        )
                        .setStyle(
                            TextInputStyle.Short
                        )
                        .setPlaceholder(
                            "Example: 500,000 gems / 2x Huge Cat"
                        )
                        .setRequired(true)
                        .setMaxLength(200);

                const roblox =
                    new TextInputBuilder()
                        .setCustomId(
                            "roblox"
                        )
                        .setLabel(
                            "Roblox User"
                        )
                        .setStyle(
                            TextInputStyle.Short
                        )
                        .setPlaceholder(
                            "Your Roblox username"
                        )
                        .setRequired(true)
                        .setMaxLength(100);

                modal.addComponents(
                    new ActionRowBuilder()
                        .addComponents(reason),

                    new ActionRowBuilder()
                        .addComponents(amount),

                    new ActionRowBuilder()
                        .addComponents(roblox)
                );

                return interaction.showModal(
                    modal
                );
            }
        }

        // ====================================================
        // MODAL SUBMISSIONS
        // ====================================================

        if (
            interaction.isModalSubmit()
        ) {

            // =================================================
            // NEW BANK REQUEST
            // =================================================

            if (
                interaction.customId ===
                "league_bank_request"
            ) {

                if (!interaction.guildId) {
                    return interaction.reply({
                        content:
                            "❌ This request must be made inside a server.",
                        ephemeral: true
                    });
                }

                const guildData =
                    getGuildData(
                        interaction.guildId
                    );

                const existing =
                    getUserOpenRequest(
                        guildData,
                        interaction.user.id
                    );

                if (existing) {
                    return interaction.reply({
                        content:
                            "❌ You already have an open request.",
                        ephemeral: true
                    });
                }

                const reason =
                    interaction.fields.getTextInputValue(
                        "reason"
                    );

                const amount =
                    interaction.fields.getTextInputValue(
                        "amount"
                    );

                const robloxUsername =
                    interaction.fields.getTextInputValue(
                        "roblox"
                    );

                const requestId =
                    generateRequestId();

                const request = {
                    id: requestId,

                    guildId:
                        interaction.guildId,

                    channelId:
                        interaction.channelId,

                    userId:
                        interaction.user.id,

                    username:
                        interaction.user.username,

                    robloxUsername,

                    reason,

                    amount,

                    status:
                        "pending",

                    createdAt:
                        Date.now(),

                    ownerIds: []
                };

                guildData.requests[
                    requestId
                ] = request;

                saveData();

                await interaction.reply({
                    content:
                        "✅ Your League Bank request has been submitted.\n\n" +
                        "🏦 An owner has been notified. You can only have **one open request** at a time.",
                    ephemeral: true
                });

                const guild =
                    interaction.guild;

                const ownerIds =
                    await notifyOwners(
                        guild,
                        request
                    );

                request.ownerIds =
                    ownerIds;

                saveData();

                if (
                    ownerIds.length === 0
                ) {

                    await interaction.followUp({
                        content:
                            "⚠️ Your request was saved, but I couldn't DM anyone with the League Bank role.",
                        ephemeral: true
                    });
                }

                return;
            }

            // =================================================
            // REJECTION REASON
            // =================================================

            if (
                interaction.customId.startsWith(
                    "bank_reject_modal_"
                )
            ) {

                const requestId =
                    interaction.customId.replace(
                        "bank_reject_modal_",
                        ""
                    );

                if (!requestId) {
                    return;
                }

                let request = null;
                let guildData = null;

                for (
                    const [guildId, guild]
                    of Object.entries(data)
                ) {

                    if (
                        guild.requests &&
                        guild.requests[
                            requestId
                        ]
                    ) {
                        request =
                            guild.requests[
                                requestId
                            ];

                        guildData =
                            guild;

                        break;
                    }
                }

                if (
                    !request ||
                    !guildData
                ) {

                    return interaction.reply({
                        content:
                            "❌ That request no longer exists.",
                        ephemeral: true
                    });
                }

                if (
                    !request.ownerIds.includes(
                        interaction.user.id
                    )
                ) {

                    return interaction.reply({
                        content:
                            "❌ You are not authorized to manage this request.",
                        ephemeral: true
                    });
                }

                if (
                    request.status !==
                    "pending"
                ) {

                    return interaction.reply({
                        content:
                            "❌ This request has already been handled.",
                        ephemeral: true
                    });
                }

                const rejectReason =
                    interaction.fields.getTextInputValue(
                        "reject_reason"
                    );

                request.status =
                    "rejected";

                request.rejectedBy =
                    interaction.user.id;

                request.rejectionReason =
                    rejectReason;

                request.completedAt =
                    Date.now();

                saveData();

                // DM requester
                try {

                    const requester =
                        await client.users.fetch(
                            request.userId
                        );

                    await requester.send(
                        `❌ **Your League Bank request was rejected.**\n\n` +
                        `🎮 **Roblox User:** ${request.robloxUsername}\n` +
                        `💰 **Requested:** ${request.amount}\n` +
                        `📝 **Reason:** ${rejectReason}`
                    );

                } catch (error) {

                    console.error(
                        "Couldn't DM rejected requester:",
                        error.message
                    );
                }

                // Ping requester in original channel
                try {

                    const guild =
                        client.guilds.cache.get(
                            request.guildId
                        );

                    const channel =
                        guild?.channels.cache.get(
                            request.channelId
                        );

                    if (channel) {

                        await channel.send({
                            content:
                                `❌ <@${request.userId}>, your League Bank request was **rejected**.\n\n` +
                                `📝 **Reason:** ${rejectReason}`,
                            allowedMentions: {
                                users: [
                                    request.userId
                                ]
                            }
                        });
                    }

                } catch (error) {

                    console.error(
                        "Couldn't send rejection notification:",
                        error.message
                    );
                }

                return interaction.reply({
                    content:
                        "❌ Request rejected and the member has been notified.",
                    ephemeral: true
                });
            }
        }

        // ====================================================
        // BUTTONS
        // ====================================================

        if (
            interaction.isButton()
        ) {

            // =================================================
            // APPROVE
            // =================================================

            if (
                interaction.customId.startsWith(
                    "bank_approve_"
                )
            ) {

                const requestId =
                    interaction.customId.replace(
                        "bank_approve_",
                        ""
                    );

                let request = null;
                let guildData = null;

                for (
                    const [guildId, guild]
                    of Object.entries(data)
                ) {

                    if (
                        guild.requests &&
                        guild.requests[
                            requestId
                        ]
                    ) {

                        request =
                            guild.requests[
                                requestId
                            ];

                        guildData =
                            guild;

                        break;
                    }
                }

                if (
                    !request ||
                    !guildData
                ) {

                    return interaction.reply({
                        content:
                            "❌ That request no longer exists.",
                        ephemeral: true
                    });
                }

                if (
                    !request.ownerIds.includes(
                        interaction.user.id
                    )
                ) {

                    return interaction.reply({
                        content:
                            "❌ You are not authorized to manage this request.",
                        ephemeral: true
                    });
                }

                if (
                    request.status !==
                    "pending"
                ) {

                    return interaction.reply({
                        content:
                            "❌ This request has already been handled.",
                        ephemeral: true
                    });
                }

                request.status =
                    "approved";

                request.approvedBy =
                    interaction.user.id;

                request.completedAt =
                    Date.now();

                saveData();

                // DM requester
                try {

                    const requester =
                        await client.users.fetch(
                            request.userId
                        );

                    await requester.send(
                        `✅ **Your League Bank request was approved!**\n\n` +
                        `🎮 **Roblox User:** ${request.robloxUsername}\n` +
                        `💰 **Approved amount/items:** ${request.amount}\n\n` +
                        `📬 Please check your mail soon!`
                    );

                } catch (error) {

                    console.error(
                        "Couldn't DM approved requester:",
                        error.message
                    );
                }

                // Ping in original channel
                try {

                    const guild =
                        client.guilds.cache.get(
                            request.guildId
                        );

                    const channel =
                        guild?.channels.cache.get(
                            request.channelId
                        );

                    if (channel) {

                        await channel.send({
                            content:
                                `✅ <@${request.userId}>, your League Bank request was **approved**!\n` +
                                `📬 Check your mail soon.`,
                            allowedMentions: {
                                users: [
                                    request.userId
                                ]
                            }
                        });
                    }

                } catch (error) {

                    console.error(
                        "Couldn't send approval notification:",
                        error.message
                    );
                }

                return interaction.update({
                    components: []
                });
            }

            // =================================================
            // REJECT BUTTON
            // =================================================

            if (
                interaction.customId.startsWith(
                    "bank_reject_"
                )
            ) {

                const requestId =
                    interaction.customId.replace(
                        "bank_reject_",
                        ""
                    );

                let request = null;

                for (
                    const guild of
                    Object.values(data)
                ) {

                    if (
                        guild.requests &&
                        guild.requests[
                            requestId
                        ]
                    ) {

                        request =
                            guild.requests[
                                requestId
                            ];

                        break;
                    }
                }

                if (
                    !request
                ) {

                    return interaction.reply({
                        content:
                            "❌ That request no longer exists.",
                        ephemeral: true
                    });
                }

                if (
                    !request.ownerIds.includes(
                        interaction.user.id
                    )
                ) {

                    return interaction.reply({
                        content:
                            "❌ You are not authorized to manage this request.",
                        ephemeral: true
                    });
                }

                if (
                    request.status !==
                    "pending"
                ) {

                    return interaction.reply({
                        content:
                            "❌ This request has already been handled.",
                        ephemeral: true
                    });
                }

                const modal =
                    new ModalBuilder()
                        .setCustomId(
                            `bank_reject_modal_${requestId}`
                        )
                        .setTitle(
                            "❌ Reject Request"
                        );

                const reason =
                    new TextInputBuilder()
                        .setCustomId(
                            "reject_reason"
                        )
                        .setLabel(
                            "Reason for rejection"
                        )
                        .setStyle(
                            TextInputStyle.Paragraph
                        )
                        .setPlaceholder(
                            "Explain why you're rejecting this request."
                        )
                        .setRequired(true)
                        .setMaxLength(1000);

                modal.addComponents(
                    new ActionRowBuilder()
                        .addComponents(reason)
                );

                return interaction.showModal(
                    modal
                );
            }
        }
    }
);

// ============================================================
// 5-MINUTE TRACKER
// ============================================================

async function runTracker() {

    console.log(
        `[${new Date().toLocaleString()}] Checking League Points...`
    );

    for (
        const [guildId, guildData]
        of Object.entries(data)
    ) {

        if (
            !guildData.users ||
            guildData.users.length === 0
        ) {
            continue;
        }

        const guild =
            client.guilds.cache.get(
                guildId
            );

        if (!guild) {
            continue;
        }

        for (
            const tracked of
            guildData.users
        ) {

            try {

                const result =
                    await checkPlayer(
                        tracked
                    );

                if (
                    result.status !==
                    "OK"
                ) {

                    console.log(
                        `${tracked.username}: no League data`
                    );

                    continue;
                }

                // First successful check
                if (
                    result.gain === null
                ) {

                    console.log(
                        `${tracked.username}: baseline established`
                    );

                    continue;
                }

                // =================================================
                // NO LP GAIN
                // =================================================

                if (
                    result.gain <= 0
                ) {

                    const channel =
                        guild.channels.cache.get(
                            tracked.channelId
                        );

                    if (!channel) {
                        continue;
                    }

                    const mention =
                        `<@${tracked.discordUserId}>`;

                    await channel.send({
                        content:
                            `${mention}\n\n` +

                            `🚨 **NO LEAGUE POINTS GAINED**\n\n` +

                            `🏆 **League:** ${result.leagueName}\n` +

                            `📊 **League Rank:** #${result.leagueRank}\n` +

                            `⭐ **League Points:** ${result.leaguePoints.toLocaleString()}\n\n` +

                            `⏰ No LP gained in the last **5 minutes**.`,

                        allowedMentions: {
                            users: [
                                tracked.discordUserId
                            ]
                        }
                    });

                    console.log(
                        `🚨 No LP gain: ${tracked.username}`
                    );

                } else {

                    console.log(
                        `✅ ${tracked.username}: +${result.gain} LP`
                    );
                }

            } catch (error) {

                console.error(
                    `Tracker error for ${tracked.username}:`,
                    error
                );
            }
        }
    }
}

// ============================================================
// START TRACKER
// ============================================================

function startTracker() {

    setTimeout(
        runTracker,
        10_000
    );

    setInterval(
        runTracker,
        5 * 60 * 1000
    );
}

// ============================================================
// LOGIN
// ============================================================

client.login(TOKEN);
