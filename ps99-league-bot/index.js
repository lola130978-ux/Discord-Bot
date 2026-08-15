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

if (!TOKEN) {
    console.error("❌ DISCORD_TOKEN is missing from .env");
    process.exit(1);
}

const PS99_API = "https://ps99.biggamesapi.io/v1";
const ROBLOX_API = "https://users.roblox.com/v1";
const DATA_FILE = path.join(__dirname, "data.json");

// Owner / bank role
const BANK_ROLE_ID = "1532984876826103889";

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
    }

    // Compatibility with older data.json files
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
// PERSONAL BANK
// ============================================================

function getPersonalBank(guildData, discordUserId) {
    if (!guildData.personalBanks) {
        guildData.personalBanks = {};
    }

    if (!guildData.personalBanks[discordUserId]) {
        guildData.personalBanks[discordUserId] = {
            xp: 0,
            gems: 0,
            items: [],
            titanics: []
        };
    }

    const bank =
        guildData.personalBanks[discordUserId];

    if (typeof bank.xp !== "number") {
        bank.xp = 0;
    }

    if (typeof bank.gems !== "number") {
        bank.gems = 0;
    }

    if (!Array.isArray(bank.items)) {
        bank.items = [];
    }

    if (!Array.isArray(bank.titanics)) {
        bank.titanics = [];
    }

    return bank;
}

// ============================================================
// PERMISSIONS
// ============================================================

function hasBankRole(interaction) {
    if (!interaction.guild || !interaction.member) {
        return false;
    }

    return interaction.member.roles.cache.has(
        BANK_ROLE_ID
    );
}

async function denyPermission(interaction) {
    return interaction.reply({
        content:
            "❌ You don't have permission to use this.",
        ephemeral: true
    });
}

// ============================================================
// API
// ============================================================

async function getJson(url, options = {}) {
    const response = await fetch(
        url,
        options
    );

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

    if (
        !result.data ||
        result.data.length === 0
    ) {
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
        Array.isArray(
            league.PointContributions
        )
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
        leagueName:
            league.Name,

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
// CHEST
// ============================================================

function rollChestReward() {

    const roll =
        Math.random() * 100;

    if (roll < 50) {
        return {
            type: "huge",
            name: "Random Huge"
        };
    }

    if (roll < 75) {
        return {
            type: "gems",
            amount: 25000000
        };
    }

    if (roll < 90) {
        return {
            type: "gems",
            amount: 45000000
        };
    }

    if (roll < 95) {
        return {
            type: "gems",
            amount: 100000000
        };
    }

    if (roll < 98) {
        return {
            type: "gems",
            amount: 250000000
        };
    }

    if (roll < 99.9) {
        return {
            type: "gems",
            amount: 300000000
        };
    }

    return {
        type: "titanic",
        name: "TITANIC"
    };
}

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
// FIND OPEN WITHDRAWAL
// ============================================================

function getOpenWithdrawal(
    guildData,
    userId
) {

    if (!guildData.withdrawals) {
        guildData.withdrawals = {};
    }

    return Object.values(
        guildData.withdrawals
    ).find(
        request =>
            request.userId === userId &&
            request.status === "pending"
    );
}

// ============================================================
// NOTIFY BANK OWNERS
// ============================================================

async function notifyWithdrawalOwners(
    guild,
    request
) {

    const role =
        guild.roles.cache.get(
            BANK_ROLE_ID
        );

    if (!role) {
        console.error(
            `Bank role ${BANK_ROLE_ID} was not found.`
        );

        return [];
    }

    const ownerIds = [];

    for (
        const member of
        role.members.values()
    ) {

        try {

            const embed =
                new EmbedBuilder()
                    .setTitle(
                        "🏦 New Withdrawal Request"
                    )
                    .setDescription(
                        "A member wants to withdraw from their personal bank."
                    )
                    .addFields(
                        {
                            name:
                                "👤 Discord User",
                            value:
                                `<@${request.userId}>`,
                            inline: true
                        },
                        {
                            name:
                                "🎮 Roblox User",
                            value:
                                request.robloxUsername ||
                                "Not provided",
                            inline: true
                        },
                        {
                            name:
                                "💰 Withdrawal",
                            value:
                                request.amount,
                            inline: false
                        }
                    )
                    .setFooter({
                        text:
                            `Request ID: ${request.id}`
                    });

            const buttons =
                new ActionRowBuilder()
                    .addComponents(

                        new ButtonBuilder()
                            .setCustomId(
                                `withdraw_approve_${request.id}`
                            )
                            .setLabel(
                                "Approve"
                            )
                            .setStyle(
                                ButtonStyle.Success
                            ),

                        new ButtonBuilder()
                            .setCustomId(
                                `withdraw_reject_${request.id}`
                            )
                            .setLabel(
                                "Reject"
                            )
                            .setStyle(
                                ButtonStyle.Danger
                            )
                    );

            await member.send({
                embeds: [embed],
                components: [buttons]
            });

            ownerIds.push(
                member.id
            );

        } catch (error) {

            console.error(
                `Could not DM ${member.user.tag}:`,
                error.message
            );
        }
    }

    return ownerIds;
}

// ============================================================
// COMMANDS
// ============================================================

const commands = [

    // ========================================================
    // ORIGINAL TRACKER
    // ========================================================

    new SlashCommandBuilder()
        .setName("adduser")
        .setDescription(
            "Track a Roblox player for PS99 League Points"
        )
        .addStringOption(option =>
            option
                .setName("username")
                .setDescription(
                    "Roblox username"
                )
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
                .setDescription(
                    "Roblox username"
                )
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

    // ========================================================
    // FACTORY RESET
    // ========================================================

    new SlashCommandBuilder()
        .setName("factoryreset")
        .setDescription(
            "Remove all tracked PS99 players"
        ),

    // ========================================================
    // LEAGUE BANK
    // ========================================================

    new SlashCommandBuilder()
        .setName("bank")
        .setDescription(
            "View the League Bank"
        ),

    new SlashCommandBuilder()
        .setName("bankadd")
        .setDescription(
            "Add gems or items to the League Bank"
        )
        .addStringOption(option =>
            option
                .setName("type")
                .setDescription(
                    "Gems or item"
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
                    "Amount"
                )
                .setMinValue(1)
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("item")
                .setDescription(
                    "Item name"
                )
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName("bankremove")
        .setDescription(
            "Remove gems or items from the League Bank"
        )
        .addStringOption(option =>
            option
                .setName("type")
                .setDescription(
                    "Gems or item"
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
                    "Amount"
                )
                .setMinValue(1)
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("item")
                .setDescription(
                    "Item name"
                )
                .setRequired(false)
        ),

    // ========================================================
    // PERSONAL XP
    // ========================================================

    new SlashCommandBuilder()
        .setName("xp")
        .setDescription(
            "Check your chest XP"
        ),

    new SlashCommandBuilder()
        .setName("givexp")
        .setDescription(
            "Give a member chest XP"
        )
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription(
                    "Discord user"
                )
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option
                .setName("amount")
                .setDescription(
                    "XP amount"
                )
                .setMinValue(1)
                .setRequired(true)
        ),

    // ========================================================
    // CHEST
    // ========================================================

    new SlashCommandBuilder()
        .setName("chest")
        .setDescription(
            "Open a chest for 1 XP"
        ),

    // ========================================================
    // PERSONAL BANK
    // ========================================================

    new SlashCommandBuilder()
        .setName("mybank")
        .setDescription(
            "View your personal bank"
        ),

    new SlashCommandBuilder()
        .setName("withdraw")
        .setDescription(
            "Request a withdrawal from your personal bank"
        )

].map(command => command.toJSON());

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
        "🏆 PS99 League Tracker is running."
    );

    console.log(
        "⏰ Checking every 5 minutes."
    );

    startTracker();
});

// ============================================================
// COMMAND HANDLER
// ============================================================

client.on(
    "interactionCreate",
    async interaction => {

        // ====================================================
        // SLASH COMMANDS
        // ====================================================

        if (interaction.isChatInputCommand()) {

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

                    // Initialize their personal bank
                    getPersonalBank(
                        guildData,
                        interaction.user.id
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

                        console.error(
                            error
                        );

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
                    `🏦 Personal banks and XP were **not changed**.`
                );
            }

            // =================================================
            // LEAGUE BANK
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
                                    name:
                                        "💎 Gems",
                                    value:
                                        bank.gems.toLocaleString(),
                                    inline: false
                                },
                                {
                                    name:
                                        "📦 Items",
                                    value:
                                        itemsText,
                                    inline: false
                                }
                            ]
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
                            "❌ You must provide an item name.",
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
                        name:
                            itemName,
                        amount:
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
                            "❌ You must provide an item name.",
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
            // XP
            // =================================================

            if (
                interaction.commandName ===
                "xp"
            ) {

                const personalBank =
                    getPersonalBank(
                        guildData,
                        interaction.user.id
                    );

                saveData();

                return interaction.reply(
                    `⭐ **Your Chest XP:** ${personalBank.xp}`
                );
            }

            // =================================================
            // GIVE XP
            // =================================================

            if (
                interaction.commandName ===
                "givexp"
            ) {

                if (!hasBankRole(interaction)) {
                    return denyPermission(
                        interaction
                    );
                }

                const user =
                    interaction.options.getUser(
                        "user"
                    );

                const amount =
                    interaction.options.getInteger(
                        "amount"
                    );

                const personalBank =
                    getPersonalBank(
                        guildData,
                        user.id
                    );

                personalBank.xp +=
                    amount;

                saveData();

                return interaction.reply(
                    `✅ Gave <@${user.id}> **${amount} XP**.\n\n` +
                    `⭐ Their new XP balance is **${personalBank.xp} XP**.`
                );
            }

            // =================================================
            // CHEST
            // =================================================

            if (
                interaction.commandName ===
                "chest"
            ) {

                const personalBank =
                    getPersonalBank(
                        guildData,
                        interaction.user.id
                    );

                if (
                    personalBank.xp < 1
                ) {

                    return interaction.reply({
                        content:
                            "❌ You need **1 XP** to open a chest.",
                        ephemeral: true
                    });
                }

                // Take XP BEFORE rolling reward
                personalBank.xp -= 1;

                const reward =
                    rollChestReward();

                if (
                    reward.type ===
                    "gems"
                ) {

                    personalBank.gems +=
                        reward.amount;

                    saveData();

                    return interaction.reply(
                        `🎁 **CHEST OPENED!**\n\n` +
                        `⭐ XP used: **1**\n` +
                        `💎 You won **${reward.amount.toLocaleString()} gems!**\n\n` +
                        `🏦 The gems have been added to your personal bank.`
                    );
                }

                if (
                    reward.type ===
                    "huge"
                ) {

                    personalBank.items.push({
                        name:
                            "Random Huge",
                        amount:
                            1
                    });

                    saveData();

                    return interaction.reply(
                        `🎁 **CHEST OPENED!**\n\n` +
                        `⭐ XP used: **1**\n` +
                        `🐾 You won a **RANDOM HUGE!**\n\n` +
                        `🏦 The Huge has been added to your personal bank.`
                    );
                }

                if (
                    reward.type ===
                    "titanic"
                ) {

                    personalBank.titanics.push(
                        "TITANIC"
                    );

                    saveData();

                    return interaction.reply(
                        `🎁 **CHEST OPENED!**\n\n` +
                        `⭐ XP used: **1**\n\n` +
                        `🚨🚨🚨 **TITANIC!** 🚨🚨🚨\n\n` +
                        `🏦 The TITANIC has been added to your personal bank.`
                    );
                }
            }

            // =================================================
            // MY BANK
            // =================================================

            if (
                interaction.commandName ===
                "mybank"
            ) {

                const personalBank =
                    getPersonalBank(
                        guildData,
                        interaction.user.id
                    );

                let itemsText =
                    "None";

                if (
                    personalBank.items.length >
                    0
                ) {

                    itemsText =
                        personalBank.items
                            .map(
                                item =>
                                    `• **${item.name}** × ${item.amount}`
                            )
                            .join("\n");
                }

                let titanicText =
                    "None";

                if (
                    personalBank.titanics.length >
                    0
                ) {

                    titanicText =
                        personalBank.titanics
                            .map(
                                item =>
                                    `• **${item}**`
                            )
                            .join("\n");
                }

                return interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle(
                                `🏦 ${interaction.user.username}'s Personal Bank`
                            )
                            .addFields(
                                {
                                    name:
                                        "⭐ XP",
                                    value:
                                        personalBank.xp.toLocaleString(),
                                    inline: true
                                },
                                {
                                    name:
                                        "💎 Gems",
                                    value:
                                        personalBank.gems.toLocaleString(),
                                    inline: true
                                },
                                {
                                    name:
                                        "🐾 Huge / Items",
                                    value:
                                        itemsText,
                                    inline: false
                                },
                                {
                                    name:
                                        "🚨 Titanics",
                                    value:
                                        titanicText,
                                    inline: false
                                }
                            )
                    ]
                });
            }

            // =================================================
            // WITHDRAW
            // =================================================

            if (
                interaction.commandName ===
                "withdraw"
            ) {

                const existing =
                    getOpenWithdrawal(
                        guildData,
                        interaction.user.id
                    );

                if (existing) {

                    return interaction.reply({
                        content:
                            "❌ You already have an open withdrawal request.",
                        ephemeral: true
                    });
                }

                const personalBank =
                    getPersonalBank(
                        guildData,
                        interaction.user.id
                    );

                if (
                    personalBank.gems <= 0 &&
                    personalBank.items.length === 0 &&
                    personalBank.titanics.length === 0
                ) {

                    return interaction.reply({
                        content:
                            "❌ Your personal bank is empty.",
                        ephemeral: true
                    });
                }

                const modal =
                    new ModalBuilder()
                        .setCustomId(
                            "withdraw_modal"
                        )
                        .setTitle(
                            "Personal Bank Withdrawal"
                        );

                const amount =
                    new TextInputBuilder()
                        .setCustomId(
                            "withdraw_amount"
                        )
                        .setLabel(
                            "What do you want to withdraw?"
                        )
                        .setStyle(
                            TextInputStyle.Paragraph
                        )
                        .setPlaceholder(
                            "Example: 25m gems, 1 Random Huge, 1 TITANIC"
                        )
                        .setRequired(true)
                        .setMaxLength(500);

                const roblox =
                    new TextInputBuilder()
                        .setCustomId(
                            "withdraw_roblox"
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
                        .addComponents(
                            amount
                        ),

                    new ActionRowBuilder()
                        .addComponents(
                            roblox
                        )
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
            // WITHDRAWAL
            // =================================================

            if (
                interaction.customId ===
                "withdraw_modal"
            ) {

                if (!interaction.guildId) {
                    return interaction.reply({
                        content:
                            "❌ This must be used in a server.",
                        ephemeral: true
                    });
                }

                const guildData =
                    getGuildData(
                        interaction.guildId
                    );

                const existing =
                    getOpenWithdrawal(
                        guildData,
                        interaction.user.id
                    );

                if (existing) {
                    return interaction.reply({
                        content:
                            "❌ You already have an open withdrawal request.",
                        ephemeral: true
                    });
                }

                const amount =
                    interaction.fields.getTextInputValue(
                        "withdraw_amount"
                    );

                const robloxUsername =
                    interaction.fields.getTextInputValue(
                        "withdraw_roblox"
                    );

                const personalBank =
                    getPersonalBank(
                        guildData,
                        interaction.user.id
                    );

                const requestId =
                    generateRequestId();

                const request = {
                    id:
                        requestId,

                    guildId:
                        interaction.guildId,

                    channelId:
                        interaction.channelId,

                    userId:
                        interaction.user.id,

                    username:
                        interaction.user.username,

                    robloxUsername:
                        robloxUsername,

                    amount:
                        amount,

                    status:
                        "pending",

                    createdAt:
                        Date.now(),

                    ownerIds:
                        []
                };

                if (
                    !guildData.withdrawals
                ) {
                    guildData.withdrawals = {};
                }

                guildData.withdrawals[
                    requestId
                ] = request;

                saveData();

                await interaction.reply({
                    content:
                        "✅ Your withdrawal request has been submitted.\n\n" +
                        "🏦 The owner has been notified.\n" +
                        "You can only have **1 open withdrawal request** at a time.",
                    ephemeral: true
                });

                const ownerIds =
                    await notifyWithdrawalOwners(
                        interaction.guild,
                        request
                    );

                request.ownerIds =
                    ownerIds;

                saveData();

                return;
            }

            // =================================================
            // REJECT WITHDRAWAL
            // =================================================

            if (
                interaction.customId.startsWith(
                    "withdraw_reject_modal_"
                )
            ) {

                const requestId =
                    interaction.customId.replace(
                        "withdraw_reject_modal_",
                        ""
                    );

                let request = null;
                let guildData = null;

                for (
                    const guild of
                    Object.values(data)
                ) {

                    if (
                        guild.withdrawals &&
                        guild.withdrawals[
                            requestId
                        ]
                    ) {

                        request =
                            guild.withdrawals[
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

                const reason =
                    interaction.fields.getTextInputValue(
                        "reject_reason"
                    );

                request.status =
                    "rejected";

                request.rejectedBy =
                    interaction.user.id;

                request.rejectionReason =
                    reason;

                request.completedAt =
                    Date.now();

                saveData();

                try {

                    const user =
                        await client.users.fetch(
                            request.userId
                        );

                    await user.send(
                        `❌ **Your withdrawal request was rejected.**\n\n` +
                        `💰 **Requested:** ${request.amount}\n` +
                        `🎮 **Roblox User:** ${request.robloxUsername}\n\n` +
                        `📝 **Reason:** ${reason}`
                    );

                } catch (error) {

                    console.error(
                        "Could not DM rejected user:",
                        error.message
                    );
                }

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
                                `❌ <@${request.userId}>, your withdrawal request was **rejected**.\n` +
                                `📝 **Reason:** ${reason}`,

                            allowedMentions: {
                                users: [
                                    request.userId
                                ]
                            }
                        });
                    }

                } catch (error) {

                    console.error(
                        "Could not send rejection ping:",
                        error.message
                    );
                }

                return interaction.reply({
                    content:
                        "❌ Withdrawal rejected. The user has been notified.",
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
            // APPROVE WITHDRAWAL
            // =================================================

            if (
                interaction.customId.startsWith(
                    "withdraw_approve_"
                )
            ) {

                const requestId =
                    interaction.customId.replace(
                        "withdraw_approve_",
                        ""
                    );

                let request = null;
                let guildData = null;

                for (
                    const guild of
                    Object.values(data)
                ) {

                    if (
                        guild.withdrawals &&
                        guild.withdrawals[
                            requestId
                        ]
                    ) {

                        request =
                            guild.withdrawals[
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

                const personalBank =
                    getPersonalBank(
                        guildData,
                        request.userId
                    );

                // IMPORTANT:
                // Approval removes only the exact things
                // the owner can verify from the request.
                //
                // For safety, the bot does NOT automatically
                // parse "25m", "Huge", etc. from free text.
                // The owner approves the request, and the
                // member's bank is then marked as withdrawn
                // manually through the owner workflow.

                request.status =
                    "approved";

                request.approvedBy =
                    interaction.user.id;

                request.completedAt =
                    Date.now();

                saveData();

                try {

                    const user =
                        await client.users.fetch(
                            request.userId
                        );

                    await user.send(
                        `✅ **Your withdrawal request was approved!**\n\n` +
                        `💰 **Withdrawal:** ${request.amount}\n` +
                        `🎮 **Roblox User:** ${request.robloxUsername}\n\n` +
                        `📬 **Check your mail soon!**`
                    );

                } catch (error) {

                    console.error(
                        "Could not DM approved user:",
                        error.message
                    );
                }

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
                                `✅ <@${request.userId}>, your withdrawal request was **approved**!\n` +
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
                        "Could not send approval ping:",
                        error.message
                    );
                }

                return interaction.update({
                    components: []
                });
            }

            // =================================================
            // REJECT WITHDRAWAL
            // =================================================

            if (
                interaction.customId.startsWith(
                    "withdraw_reject_"
                )
            ) {

                const requestId =
                    interaction.customId.replace(
                        "withdraw_reject_",
                        ""
                    );

                let request = null;

                for (
                    const guild of
                    Object.values(data)
                ) {

                    if (
                        guild.withdrawals &&
                        guild.withdrawals[
                            requestId
                        ]
                    ) {

                        request =
                            guild.withdrawals[
                                requestId
                            ];

                        break;
                    }
                }

                if (!request) {

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
                            `withdraw_reject_modal_${requestId}`
                        )
                        .setTitle(
                            "Reject Withdrawal"
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
                            "Why are you rejecting this withdrawal?"
                        )
                        .setRequired(true)
                        .setMaxLength(1000);

                modal.addComponents(
                    new ActionRowBuilder()
                        .addComponents(
                            reason
                        )
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

                // First successful check:
                // establish baseline.
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

    // First automatic check 10 seconds after startup.
    setTimeout(
        runTracker,
        10_000
    );

    // Then every 5 minutes.
    setInterval(
        runTracker,
        5 * 60 * 1000
    );
}

// ============================================================
// LOGIN
// ============================================================

client.login(TOKEN);
