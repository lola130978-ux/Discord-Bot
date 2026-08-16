require("dotenv").config();

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require("discord.js");

const fs = require("fs");
const path = require("path");

const TOKEN = process.env.DISCORD_TOKEN;

if (!TOKEN) {
    console.error("❌ DISCORD_TOKEN is missing from environment variables.");
    process.exit(1);
}

const PS99_API = "https://ps99.biggamesapi.io/v1";
const ROBLOX_API = "https://users.roblox.com/v1";

const DATA_FILE = path.join(__dirname, "data.json");

// Bank Owner role
const BANK_ROLE_ID = "1532984876826103889";

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ]
});

// ============================================================
// DATA
// ============================================================

let data = {};

if (fs.existsSync(DATA_FILE)) {
    try {
        data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    } catch (error) {
        console.error("⚠️ Could not read data.json:", error.message);
        data = {};
    }
}

function saveData() {
    try {
        fs.writeFileSync(
            DATA_FILE,
            JSON.stringify(data, null, 2)
        );
    } catch (error) {
        console.error("❌ Could not save data.json:", error);
    }
}

function getGuildData(guildId) {
    if (!data[guildId]) {
        data[guildId] = {
            users: [],
            bank: {
                gems: 0,
                items: [],
                titanics: []
            },
            personalBanks: {},
            withdrawals: {}
        };
    }

    const guildData = data[guildId];

    if (!Array.isArray(guildData.users)) {
        guildData.users = [];
    }

    if (!guildData.bank) {
        guildData.bank = {};
    }

    if (typeof guildData.bank.gems !== "number") {
        guildData.bank.gems = 0;
    }

    if (!Array.isArray(guildData.bank.items)) {
        guildData.bank.items = [];
    }

    if (!Array.isArray(guildData.bank.titanics)) {
        guildData.bank.titanics = [];
    }

    if (!guildData.personalBanks) {
        guildData.personalBanks = {};
    }

    if (!guildData.withdrawals) {
        guildData.withdrawals = {};
    }

    return guildData;
}

function getPersonalBank(guildData, userId) {
    if (!guildData.personalBanks) {
        guildData.personalBanks = {};
    }

    if (!guildData.personalBanks[userId]) {
        guildData.personalBanks[userId] = {
            xp: 0,
            gems: 0,
            items: [],
            titanics: []
        };
    }

    const bank = guildData.personalBanks[userId];

    if (typeof bank.xp !== "number") bank.xp = 0;
    if (typeof bank.gems !== "number") bank.gems = 0;
    if (!Array.isArray(bank.items)) bank.items = [];
    if (!Array.isArray(bank.titanics)) bank.titanics = [];

    return bank;
}

// ============================================================
// PERMISSIONS
// ============================================================

async function isBankOwner(userId, guildId) {
    if (!guildId) return false;

    try {
        const guild = client.guilds.cache.get(guildId);

        if (!guild) return false;

        const member = await guild.members.fetch(userId);

        return member.roles.cache.has(BANK_ROLE_ID);
    } catch (error) {
        console.error(
            `Could not verify bank owner ${userId}:`,
            error.message
        );

        return false;
    }
}

function hasBankRole(interaction) {
    if (!interaction.guild || !interaction.member) {
        return false;
    }

    return interaction.member.roles.cache.has(BANK_ROLE_ID);
}

async function denyPermission(interaction) {
    return interaction.reply({
        content: "❌ You don't have permission to use this.",
        ephemeral: true
    });
}

// ============================================================
// API
// ============================================================

async function getJson(url, options = {}) {
    const response = await fetch(url, options);

    let body = null;

    try {
        body = await response.json();
    } catch {}

    if (!response.ok) {
        const message =
            body?.error?.message ||
            body?.message ||
            `HTTP ${response.status}`;

        const error = new Error(message);
        error.status = response.status;
        throw error;
    }

    return body;
}

// ============================================================
// ROBLOX
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
// PS99 LEAGUES
// ============================================================

async function findPlayerLeague(robloxUserId) {
    try {
        const result = await getJson(
            `${PS99_API}/leagues/players/${robloxUserId}`
        );

        if (!result.data) return null;

        return {
            leagueName: result.data.League?.Name || null,
            leagueId: result.data.League?.ID || null,
            leaguePoints: Number(result.data.Points || 0),
            timestamp: result.data.Timestamp
                ? Number(result.data.Timestamp)
                : null
        };
    } catch (error) {
        if (error.status === 404) return null;
        throw error;
    }
}

async function getLeague(leagueName) {
    return await getJson(
        `${PS99_API}/leagues/${encodeURIComponent(leagueName)}`
    );
}

async function getPlayerFromLeague(
    leagueName,
    robloxUserId
) {
    const response = await getLeague(leagueName);
    const league = response.data;

    if (!league) return null;

    const contributions =
        Array.isArray(league.PointContributions)
            ? league.PointContributions
            : [];

    const index = contributions.findIndex(
        player =>
            Number(player.UserID) ===
            Number(robloxUserId)
    );

    if (index === -1) return null;

    const player = contributions[index];

    return {
        leagueName: league.Name,
        leagueId: league.ID,
        leaguePoints: Number(player.Points || 0),
        leagueRank: index + 1,
        timestamp: player.Timestamp
            ? Number(player.Timestamp)
            : null
    };
}

async function checkPlayer(tracked) {
    if (!tracked.leagueName) {
        const discovered =
            await findPlayerLeague(
                tracked.robloxUserId
            );

        if (!discovered) {
            return {
                status: "LEAGUE_NOT_DISCOVERED"
            };
        }

        tracked.leagueName =
            discovered.leagueName;

        tracked.leagueId =
            discovered.leagueId;
    }

    let result =
        await getPlayerFromLeague(
            tracked.leagueName,
            tracked.robloxUserId
        );

    if (!result) {
        const discovered =
            await findPlayerLeague(
                tracked.robloxUserId
            );

        if (discovered?.leagueName) {
            tracked.leagueName =
                discovered.leagueName;

            tracked.leagueId =
                discovered.leagueId;

            result =
                await getPlayerFromLeague(
                    tracked.leagueName,
                    tracked.robloxUserId
                );
        }

        if (!result) {
            return {
                status: "PLAYER_NOT_FOUND"
            };
        }
    }

    const previousPoints =
        tracked.lastLeaguePoints;

    const previousTimestamp =
        tracked.lastContributionTimestamp;

    const previousRank =
        tracked.lastLeagueRank;

    let gain = null;

    if (
        previousPoints !== null &&
        previousPoints !== undefined
    ) {
        gain =
            result.leaguePoints -
            previousPoints;
    }

    const timestampChanged =
        previousTimestamp !== null &&
        previousTimestamp !== undefined &&
        result.timestamp !== null &&
        result.timestamp !== previousTimestamp;

    if (
        previousPoints === null ||
        previousPoints === undefined
    ) {
        tracked.unchangedChecks = 0;
    } else if (
        gain > 0 ||
        timestampChanged
    ) {
        tracked.unchangedChecks = 0;
    } else {
        tracked.unchangedChecks =
            (tracked.unchangedChecks || 0) + 1;
    }

    tracked.lastLeague =
        result.leagueName;

    tracked.lastLeaguePoints =
        result.leaguePoints;

    tracked.lastLeagueRank =
        result.leagueRank;

    tracked.lastContributionTimestamp =
        result.timestamp;

    tracked.lastChecked =
        Date.now();

    saveData();

    return {
        status: "OK",
        leagueName: result.leagueName,
        leaguePoints: result.leaguePoints,
        leagueRank: result.leagueRank,
        timestamp: result.timestamp,
        gain,
        timestampChanged,
        unchangedChecks:
            tracked.unchangedChecks || 0,
        previousPoints,
        previousTimestamp,
        previousRank
    };
}

// ============================================================
// CHEST
// ============================================================

function rollChestReward() {
    const roll = Math.random() * 100;

    if (roll < 50) {
        return {
            type: "huge",
            name: "Random Huge"
        };
    }

    if (roll < 75) {
        return {
            type: "gems",
            amount: 25_000_000
        };
    }

    if (roll < 90) {
        return {
            type: "gems",
            amount: 45_000_000
        };
    }

    if (roll < 95) {
        return {
            type: "gems",
            amount: 100_000_000
        };
    }

    if (roll < 98) {
        return {
            type: "gems",
            amount: 250_000_000
        };
    }

    if (roll < 99.9) {
        return {
            type: "gems",
            amount: 300_000_000
        };
    }

    return {
        type: "titanic",
        name: "TITANIC"
    };
}

function chestEmbed() {
    return new EmbedBuilder()
        .setTitle("🎁 PS99 League Chest")
        .setDescription(
            "Spend **1 XP** to open this chest."
        )
        .addFields(
            {
                name: "🐾 Random Huge",
                value: "50%",
                inline: true
            },
            {
                name: "💎 25M Gems",
                value: "25%",
                inline: true
            },
            {
                name: "💎 45M Gems",
                value: "15%",
                inline: true
            },
            {
                name: "💎 100M Gems",
                value: "5%",
                inline: true
            },
            {
                name: "💎 250M Gems",
                value: "3%",
                inline: true
            },
            {
                name: "💎 300M Gems",
                value: "1.9%",
                inline: true
            },
            {
                name: "🚨 TITANIC",
                value: "0.1%",
                inline: true
            },
            {
                name: "⭐ Cost",
                value: "1 XP",
                inline: true
            }
        );
}

// ============================================================
// WITHDRAWAL HELPERS
// ============================================================

function generateRequestId() {
    return (
        Date.now().toString(36) +
        Math.random()
            .toString(36)
            .substring(2, 8)
    );
}

function getOpenWithdrawal(guildData, userId) {
    return Object.values(
        guildData.withdrawals || {}
    ).find(
        request =>
            request.userId === userId &&
            request.status === "pending"
    );
}

function findWithdrawalRequest(requestId) {
    for (
        const [guildId, guildData]
        of Object.entries(data)
    ) {
        if (
            guildData.withdrawals &&
            guildData.withdrawals[requestId]
        ) {
            return {
                guildId,
                guildData,
                request:
                    guildData.withdrawals[requestId]
            };
        }
    }

    return null;
}

// ============================================================
// PARSE WITHDRAWAL
// ============================================================

function parseWithdrawalRequest(text) {
    const result = {
        gems: 0,
        items: [],
        titanics: 0
    };

    const lower = text.toLowerCase();

    const gemMatches = [
        ...lower.matchAll(
            /([\d,.]+)\s*(k|m|b|t)?\s*(?:gems?|diamonds?)/gi
        )
    ];

    for (const match of gemMatches) {
        let amount =
            Number(
                match[1].replace(/,/g, "")
            );

        const suffix = match[2]?.toLowerCase();

        if (suffix === "k") amount *= 1_000;
        if (suffix === "m") amount *= 1_000_000;
        if (suffix === "b") amount *= 1_000_000_000;
        if (suffix === "t") amount *= 1_000_000_000_000;

        result.gems += Math.floor(amount);
    }

    const hugeMatch =
        lower.match(
            /(\d+)\s*(?:x\s*)?(?:random\s+huge|huge)/i
        );

    if (hugeMatch) {
        result.items.push({
            name: "Random Huge",
            amount: Number(hugeMatch[1])
        });
    }

    const titanicMatch =
        lower.match(
            /(\d+)\s*(?:x\s*)?titanic/i
        );

    if (titanicMatch) {
        result.titanics =
            Number(titanicMatch[1]);
    }

    const genericMatches =
        text.matchAll(
            /(\d+)\s*x?\s+([^,\n]+)/gi
        );

    for (const match of genericMatches) {
        const amount = Number(match[1]);
        const name = match[2].trim();

        if (
            /gems?|diamonds?|titanic|random huge/i.test(
                name
            )
        ) {
            continue;
        }

        if (name && amount > 0) {
            result.items.push({
                name,
                amount
            });
        }
    }

    return result;
}

// ============================================================
// CHECK BANK OWNERSHIP
// ONLY USED WHEN APPROVING
// ============================================================

function checkWithdrawalOwnership(bank, parsed) {
    if (parsed.gems > bank.gems) {
        return {
            ok: false,
            reason:
                `Requested ${parsed.gems.toLocaleString()} gems, but the bank only has ${bank.gems.toLocaleString()}.`
        };
    }

    if (
        parsed.titanics >
        (bank.titanics?.length || 0)
    ) {
        return {
            ok: false,
            reason:
                `Requested ${parsed.titanics} TITANIC(s), but the bank does not have enough.`
        };
    }

    for (const requested of parsed.items) {
        const existing =
            bank.items.find(
                item =>
                    item.name.toLowerCase() ===
                    requested.name.toLowerCase()
            );

        if (
            !existing ||
            existing.amount <
            requested.amount
        ) {
            return {
                ok: false,
                reason:
                    `Requested ${requested.amount}x ${requested.name}, but the bank does not have enough.`
            };
        }
    }

    return {
        ok: true
    };
}

// ============================================================
// REMOVE WITHDRAWAL ITEMS
// ============================================================

function removeWithdrawalItems(bank, parsed) {
    bank.gems -= parsed.gems;

    for (const requested of parsed.items) {
        const existing =
            bank.items.find(
                item =>
                    item.name.toLowerCase() ===
                    requested.name.toLowerCase()
            );

        if (existing) {
            existing.amount -=
                requested.amount;

            if (existing.amount <= 0) {
                bank.items =
                    bank.items.filter(
                        item =>
                            item !== existing
                    );
            }
        }
    }

    if (Array.isArray(bank.titanics)) {
        for (
            let i = 0;
            i < parsed.titanics;
            i++
        ) {
            bank.titanics.shift();
        }
    }
}

// ============================================================
// NOTIFY BANK OWNERS
// ============================================================

async function notifyWithdrawalOwners(guild, request) {
    const role =
        guild.roles.cache.get(
            BANK_ROLE_ID
        );

    if (!role) {
        console.error(
            `❌ Bank role ${BANK_ROLE_ID} was not found.`
        );

        return [];
    }

    const ownerIds = [];

    for (
        const member of role.members.values()
    ) {
        try {
            const embed =
                new EmbedBuilder()
                    .setTitle(
                        "🏦 New Withdrawal Request"
                    )
                    .setDescription(
                        "A member has submitted a withdrawal request."
                    )
                    .addFields(
                        {
                            name: "👤 Discord User",
                            value:
                                `<@${request.userId}>`,
                            inline: true
                        },
                        {
                            name: "🎮 Roblox User",
                            value:
                                request.robloxUsername ||
                                "Not provided",
                            inline: true
                        },
                        {
                            name: "🏦 Source",
                            value:
                                request.source ===
                                "league_bank"
                                    ? "League Bank"
                                    : "Personal Bank",
                            inline: true
                        },
                        {
                            name: "💰 Requested",
                            value:
                                request.amount,
                            inline: false
                        },
                        {
                            name: "📝 Reason",
                            value:
                                request.reason ||
                                "No reason provided",
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

            ownerIds.push(member.id);

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

    new SlashCommandBuilder()
        .setName("adduser")
        .setDescription("Add a Roblox player to the tracker")
        .addStringOption(option =>
            option
                .setName("username")
                .setDescription("Roblox username")
                .setRequired(true)
        )
        .addUserOption(option =>
            option
                .setName("discorduser")
                .setDescription("Discord user to ping")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("removeuser")
        .setDescription("Remove a tracked player")
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("Discord user")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("users")
        .setDescription("Show tracked users"),

    new SlashCommandBuilder()
        .setName("check")
        .setDescription("Check all tracked players"),

    new SlashCommandBuilder()
        .setName("lockin")
        .setDescription("Ping a selected user 5 times")
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("User to ping")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("xp")
        .setDescription("Check your XP"),

    new SlashCommandBuilder()
        .setName("givexp")
        .setDescription("Give XP to one member")
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("Member")
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option
                .setName("amount")
                .setDescription("XP amount")
                .setMinValue(1)
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("givexpall")
        .setDescription("Give XP to every member")
        .addIntegerOption(option =>
            option
                .setName("amount")
                .setDescription("XP amount")
                .setMinValue(1)
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("chest")
        .setDescription("View the chest and its odds"),

    new SlashCommandBuilder()
        .setName("bank")
        .setDescription("View the League Bank"),

    new SlashCommandBuilder()
        .setName("bankadd")
        .setDescription("Add gems or items to the League Bank")
        .addStringOption(option =>
            option
                .setName("type")
                .setDescription("Gems or item")
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
                .setDescription("Amount")
                .setMinValue(1)
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("item")
                .setDescription("Item name")
        ),

    new SlashCommandBuilder()
        .setName("bankremove")
        .setDescription("Remove gems or items from the League Bank")
        .addStringOption(option =>
            option
                .setName("type")
                .setDescription("Gems or item")
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
                .setDescription("Amount")
                .setMinValue(1)
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("item")
                .setDescription("Item name")
        ),

    new SlashCommandBuilder()
        .setName("factoryreset")
        .setDescription("Remove all tracked players"),

    new SlashCommandBuilder()
        .setName("mybank")
        .setDescription("View your personal bank"),

    new SlashCommandBuilder()
        .setName("withdraw")
        .setDescription("Submit a withdrawal request from your personal bank"),

    new SlashCommandBuilder()
        .setName("bankwithdraw")
        .setDescription("Submit a withdrawal request from the League Bank")

].map(command => command.toJSON());

// ============================================================
// READY
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
            "❌ Command registration failed:",
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
// INTERACTIONS
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
                        "❌ Use this inside a server.",
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

            if (interaction.commandName === "adduser") {

                const username =
                    interaction.options.getString(
                        "username"
                    );

                const discordUser =
                    interaction.options.getUser(
                        "discorduser"
                    );

                if (
                    guildData.users.some(
                        user =>
                            user.username?.toLowerCase() ===
                            username.toLowerCase()
                    )
                ) {
                    return interaction.reply({
                        content:
                            "❌ That Roblox user is already tracked.",
                        ephemeral: true
                    });
                }

                await interaction.deferReply();

                try {
                    const roblox =
                        await findRobloxUser(
                            username
                        );

                    if (!roblox) {
                        return interaction.editReply(
                            `❌ Roblox user **${username}** was not found.`
                        );
                    }

                    const tracked = {
                        username:
                            roblox.username,

                        displayName:
                            roblox.displayName,

                        robloxUserId:
                            roblox.userId,

                        discordUserId:
                            discordUser.id,

                        channelId:
                            interaction.channelId,

                        leagueName: null,
                        leagueId: null,
                        lastLeague: null,
                        lastLeaguePoints: null,
                        lastLeagueRank: null,
                        lastContributionTimestamp: null,
                        lastChecked: null,
                        unchangedChecks: 0
                    };

                    guildData.users.push(
                        tracked
                    );

                    saveData();

                    const result =
                        await checkPlayer(
                            tracked
                        );

                    if (result.status === "OK") {
                        return interaction.editReply(
                            `✅ **${roblox.username}** added!\n\n` +
                            `👤 Ping: <@${discordUser.id}>\n` +
                            `🏆 League: **${result.leagueName}**\n` +
                            `📊 Rank: **#${result.leagueRank}**\n` +
                            `⭐ Points: **${result.leaguePoints.toLocaleString()}**`
                        );
                    }

                    return interaction.editReply(
                        `✅ **${roblox.username}** was added.\n\n` +
                        `⚠️ League not discovered yet.`
                    );

                } catch (error) {
                    console.error(
                        "Add user error:",
                        error
                    );

                    return interaction.editReply(
                        "❌ An error occurred while adding that player."
                    );
                }
            }

            // =================================================
            // REMOVE USER
            // =================================================

            if (interaction.commandName === "removeuser") {

                const user =
                    interaction.options.getUser(
                        "user"
                    );

                const before =
                    guildData.users.length;

                guildData.users =
                    guildData.users.filter(
                        tracked =>
                            tracked.discordUserId !==
                            user.id
                    );

                if (
                    before ===
                    guildData.users.length
                ) {
                    return interaction.reply({
                        content:
                            "❌ That user isn't being tracked.",
                        ephemeral: true
                    });
                }

                saveData();

                return interaction.reply(
                    `✅ Removed <@${user.id}> from tracking.`
                );
            }

            // =================================================
            // USERS
            // =================================================

            if (interaction.commandName === "users") {

                if (guildData.users.length === 0) {
                    return interaction.reply(
                        "📭 No users are being tracked."
                    );
                }

                const list =
                    guildData.users.map(
                        (user, index) =>
                            `**${index + 1}. ${user.username}**\n` +
                            `👤 <@${user.discordUserId}>\n` +
                            `🏆 League: **${user.leagueName || "Searching..."}**\n` +
                            `📊 Rank: **${user.lastLeagueRank ? `#${user.lastLeagueRank}` : "Unknown"}**\n` +
                            `⭐ Points: **${user.lastLeaguePoints !== null && user.lastLeaguePoints !== undefined ? user.lastLeaguePoints.toLocaleString() : "Unknown"}**`
                    ).join("\n\n");

                return interaction.reply(
                    `🏆 **PS99 League Tracker**\n\n${list}`
                );
            }

            // =================================================
            // CHECK
            // =================================================

            if (interaction.commandName === "check") {

                await interaction.deferReply();

                if (guildData.users.length === 0) {
                    return interaction.editReply(
                        "📭 No users are being tracked."
                    );
                }

                const results = [];

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
                            result.status ===
                            "LEAGUE_NOT_DISCOVERED"
                        ) {
                            results.push(
                                `👤 **${tracked.username}** — 🔎 Still searching for League`
                            );
                            continue;
                        }

                        if (
                            result.status ===
                            "PLAYER_NOT_FOUND"
                        ) {
                            results.push(
                                `👤 **${tracked.username}** — ⚠️ Contribution not found`
                            );
                            continue;
                        }

                        const gain =
                            result.gain === null
                                ? "Baseline"
                                : result.gain > 0
                                    ? `+${result.gain.toLocaleString()}`
                                    : result.gain.toLocaleString();

                        results.push(
                            `👤 **${tracked.username}**\n` +
                            `🏆 League: **${result.leagueName}**\n` +
                            `📊 Rank: **#${result.leagueRank}**\n` +
                            `⭐ Points: **${result.leaguePoints.toLocaleString()}**\n` +
                            `📈 Change: **${gain}**`
                        );

                    } catch {
                        results.push(
                            `❌ **${tracked.username}** — API error`
                        );
                    }
                }

                return interaction.editReply(
                    results.join("\n\n")
                );
            }

            // =================================================
            // LOCK IN
            // =================================================

            if (interaction.commandName === "lockin") {

                const user =
                    interaction.options.getUser(
                        "user"
                    );

                await interaction.reply({
                    content:
                        "🔒 Sending 5 lock-in pings...",
                    ephemeral: true
                });

                for (let i = 0; i < 5; i++) {

                    await interaction.channel.send({
                        content:
                            `🔒 **LOCK IN GET ON** <@${user.id}>`,
                        allowedMentions: {
                            users: [user.id]
                        }
                    });

                    await new Promise(
                        resolve =>
                            setTimeout(
                                resolve,
                                500
                            )
                    );
                }

                return;
            }

            // =================================================
            // XP
            // =================================================

            if (interaction.commandName === "xp") {

                const bank =
                    getPersonalBank(
                        guildData,
                        interaction.user.id
                    );

                return interaction.reply(
                    `⭐ **Your XP:** ${bank.xp.toLocaleString()}`
                );
            }

            // =================================================
            // GIVE XP
            // =================================================

            if (interaction.commandName === "givexp") {

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

                const bank =
                    getPersonalBank(
                        guildData,
                        user.id
                    );

                bank.xp += amount;

                saveData();

                return interaction.reply(
                    `✅ Gave <@${user.id}> **${amount.toLocaleString()} XP**.\n` +
                    `⭐ New balance: **${bank.xp.toLocaleString()} XP**`
                );
            }

            // =================================================
            // GIVE XP ALL
            // =================================================

            if (interaction.commandName === "givexpall") {

                if (!hasBankRole(interaction)) {
                    return denyPermission(
                        interaction
                    );
                }

                const amount =
                    interaction.options.getInteger(
                        "amount"
                    );

                await interaction.deferReply();

                try {
                    await interaction.guild.members.fetch();

                    let count = 0;

                    for (
                        const member of
                        interaction.guild.members.cache.values()
                    ) {
                        if (member.user.bot) continue;

                        const bank =
                            getPersonalBank(
                                guildData,
                                member.id
                            );

                        bank.xp += amount;
                        count++;
                    }

                    saveData();

                    return interaction.editReply(
                        `✅ Gave **${amount.toLocaleString()} XP** to **${count} members**.`
                    );

                } catch (error) {
                    console.error(
                        "Give XP all error:",
                        error
                    );

                    return interaction.editReply(
                        "❌ Couldn't give XP to everyone."
                    );
                }
            }

            // =================================================
            // CHEST
            // =================================================

            if (interaction.commandName === "chest") {

                const row =
                    new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId(
                                    "open_chest"
                                )
                                .setLabel(
                                    "Open Chest — 1 XP"
                                )
                                .setEmoji("🎁")
                                .setStyle(
                                    ButtonStyle.Primary
                                )
                        );

                return interaction.reply({
                    embeds: [
                        chestEmbed()
                    ],
                    components: [row]
                });
            }

            // =================================================
            // MY BANK
            // =================================================

            if (interaction.commandName === "mybank") {

                const bank =
                    getPersonalBank(
                        guildData,
                        interaction.user.id
                    );

                const items =
                    bank.items.length
                        ? bank.items.map(
                            item =>
                                `• **${item.name}** × ${item.amount}`
                        ).join("\n")
                        : "None";

                const titanics =
                    bank.titanics.length
                        ? bank.titanics.map(
                            item =>
                                `• **${item}**`
                        ).join("\n")
                        : "None";

                return interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle(
                                `🏦 ${interaction.user.username}'s Personal Bank`
                            )
                            .addFields(
                                {
                                    name: "⭐ XP",
                                    value:
                                        bank.xp.toLocaleString(),
                                    inline: true
                                },
                                {
                                    name: "💎 Gems",
                                    value:
                                        bank.gems.toLocaleString(),
                                    inline: true
                                },
                                {
                                    name: "🐾 Items",
                                    value: items
                                },
                                {
                                    name: "🚨 Titanics",
                                    value: titanics
                                }
                            )
                    ]
                });
            }

            // =================================================
            // LEAGUE BANK
            // =================================================

            if (interaction.commandName === "bank") {

                const bank =
                    guildData.bank;

                const items =
                    bank.items.length
                        ? bank.items.map(
                            item =>
                                `• **${item.name}** × ${item.amount}`
                        ).join("\n")
                        : "None";

                const titanics =
                    bank.titanics.length
                        ? bank.titanics.map(
                            item =>
                                `• **${item}**`
                        ).join("\n")
                        : "None";

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
                                        bank.gems.toLocaleString()
                                },
                                {
                                    name: "📦 Items",
                                    value: items
                                },
                                {
                                    name: "🚨 Titanics",
                                    value: titanics
                                }
                            )
                    ]
                });
            }

            // =================================================
            // BANK ADD
            // BANK OWNER ONLY
            // =================================================

            if (interaction.commandName === "bankadd") {

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

                if (type === "gems") {

                    guildData.bank.gems +=
                        amount;

                    saveData();

                    return interaction.reply(
                        `✅ Added **${amount.toLocaleString()} gems** to the League Bank.`
                    );
                }

                const existing =
                    guildData.bank.items.find(
                        item =>
                            item.name.toLowerCase() ===
                            itemName.toLowerCase()
                    );

                if (existing) {
                    existing.amount += amount;
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
            // BANK OWNER ONLY
            // =================================================

            if (interaction.commandName === "bankremove") {

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

                if (type === "gems") {

                    if (
                        amount >
                        guildData.bank.gems
                    ) {
                        return interaction.reply({
                            content:
                                "❌ Not enough League Bank gems.",
                            ephemeral: true
                        });
                    }

                    guildData.bank.gems -=
                        amount;

                    saveData();

                    return interaction.reply(
                        `✅ Removed **${amount.toLocaleString()} gems** from the League Bank.`
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
                            "❌ Not enough of that item in the League Bank.",
                        ephemeral: true
                    });
                }

                existing.amount -= amount;

                if (existing.amount <= 0) {
                    guildData.bank.items =
                        guildData.bank.items.filter(
                            item =>
                                item !== existing
                        );
                }

                saveData();

                return interaction.reply(
                    `✅ Removed **${amount}x ${itemName}** from the League Bank.`
                );
            }

            // =================================================
            // FACTORY RESET
            // BANK OWNER ONLY
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
                    `🏦 Personal banks and XP were NOT changed.`
                );
            }

            // =================================================
            // PERSONAL WITHDRAW
            // ANY MEMBER CAN SUBMIT
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
                            "What do you want?"
                        )
                        .setStyle(
                            TextInputStyle.Paragraph
                        )
                        .setPlaceholder(
                            "25m gems, 1 Random Huge, 1 TITANIC"
                        )
                        .setRequired(true)
                        .setMaxLength(500);

                const roblox =
                    new TextInputBuilder()
                        .setCustomId(
                            "withdraw_roblox"
                        )
                        .setLabel(
                            "Roblox Username"
                        )
                        .setStyle(
                            TextInputStyle.Short
                        )
                        .setPlaceholder(
                            "Your Roblox username"
                        )
                        .setRequired(true)
                        .setMaxLength(100);

                const reason =
                    new TextInputBuilder()
                        .setCustomId(
                            "withdraw_reason"
                        )
                        .setLabel(
                            "Reason for withdrawal"
                        )
                        .setStyle(
                            TextInputStyle.Paragraph
                        )
                        .setPlaceholder(
                            "Why are you withdrawing?"
                        )
                        .setRequired(true)
                        .setMaxLength(500);

                modal.addComponents(
                    new ActionRowBuilder()
                        .addComponents(amount),

                    new ActionRowBuilder()
                        .addComponents(roblox),

                    new ActionRowBuilder()
                        .addComponents(reason)
                );

                return interaction.showModal(
                    modal
                );
            }

            // =================================================
            // LEAGUE BANK WITHDRAW
            // ANY MEMBER CAN SUBMIT
            // =================================================

            if (
                interaction.commandName ===
                "bankwithdraw"
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

                const modal =
                    new ModalBuilder()
                        .setCustomId(
                            "bank_withdraw_modal"
                        )
                        .setTitle(
                            "League Bank Withdrawal"
                        );

                const amount =
                    new TextInputBuilder()
                        .setCustomId(
                            "bank_withdraw_amount"
                        )
                        .setLabel(
                            "What do you want?"
                        )
                        .setStyle(
                            TextInputStyle.Paragraph
                        )
                        .setPlaceholder(
                            "25m gems, 1 Random Huge"
                        )
                        .setRequired(true)
                        .setMaxLength(500);

                const roblox =
                    new TextInputBuilder()
                        .setCustomId(
                            "bank_withdraw_roblox"
                        )
                        .setLabel(
                            "Roblox Username"
                        )
                        .setStyle(
                            TextInputStyle.Short
                        )
                        .setPlaceholder(
                            "Your Roblox username"
                        )
                        .setRequired(true)
                        .setMaxLength(100);

                const reason =
                    new TextInputBuilder()
                        .setCustomId(
                            "bank_withdraw_reason"
                        )
                        .setLabel(
                            "Reason for withdrawal"
                        )
                        .setStyle(
                            TextInputStyle.Paragraph
                        )
                        .setPlaceholder(
                            "Why do you need this from the League Bank?"
                        )
                        .setRequired(true)
                        .setMaxLength(500);

                modal.addComponents(
                    new ActionRowBuilder()
                        .addComponents(amount),

                    new ActionRowBuilder()
                        .addComponents(roblox),

                    new ActionRowBuilder()
                        .addComponents(reason)
                );

                return interaction.showModal(
                    modal
                );
            }
        }

        // ====================================================
        // BUTTONS
        // ====================================================

        if (interaction.isButton()) {

            // =================================================
            // CHEST
            // =================================================

            if (
                interaction.customId ===
                "open_chest"
            ) {

                if (!interaction.guildId) {
                    return interaction.reply({
                        content:
                            "❌ Use this inside a server.",
                        ephemeral: true
                    });
                }

                const guildData =
                    getGuildData(
                        interaction.guildId
                    );

                const bank =
                    getPersonalBank(
                        guildData,
                        interaction.user.id
                    );

                if (bank.xp < 1) {
                    return interaction.reply({
                        content:
                            "❌ You need **1 XP**.",
                        ephemeral: true
                    });
                }

                bank.xp--;

                const reward =
                    rollChestReward();

                if (reward.type === "gems") {

                    bank.gems +=
                        reward.amount;

                    saveData();

                    return interaction.reply(
                        `🎁 **CHEST OPENED!**\n\n` +
                        `💎 You won **${reward.amount.toLocaleString()} gems!**\n\n` +
                        `⭐ Remaining XP: **${bank.xp.toLocaleString()}**`
                    );
                }

                if (reward.type === "huge") {

                    bank.items.push({
                        name: "Random Huge",
                        amount: 1
                    });

                    saveData();

                    return interaction.reply(
                        `🎁 **CHEST OPENED!**\n\n` +
                        `🐾 **YOU WON A RANDOM HUGE!**\n\n` +
                        `⭐ Remaining XP: **${bank.xp.toLocaleString()}**`
                    );
                }

                if (reward.type === "titanic") {

                    bank.titanics.push(
                        "TITANIC"
                    );

                    saveData();

                    return interaction.reply(
                        `🚨🚨🚨 **TITANIC!** 🚨🚨🚨\n\n` +
                        `YOU HIT THE **0.1% TITANIC!**\n\n` +
                        `⭐ Remaining XP: **${bank.xp.toLocaleString()}**`
                    );
                }
            }

            // =================================================
            // APPROVE
            // BANK OWNER ONLY
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

                const found =
                    findWithdrawalRequest(
                        requestId
                    );

                if (!found) {
                    return interaction.reply({
                        content:
                            "❌ Request no longer exists.",
                        ephemeral: true
                    });
                }

                const {
                    guildId,
                    guildData,
                    request
                } = found;

                const owner =
                    await isBankOwner(
                        interaction.user.id,
                        guildId
                    );

                if (!owner) {
                    return interaction.reply({
                        content:
                            "❌ You are not a Bank Owner.",
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

                const bank =
                    request.source ===
                    "league_bank"
                        ? guildData.bank
                        : getPersonalBank(
                            guildData,
                            request.userId
                        );

                const parsed =
                    parseWithdrawalRequest(
                        request.amount
                    );

                // =============================================
                // IMPORTANT:
                // THE BANK IS CHECKED HERE, NOT WHEN SUBMITTED
                // =============================================

                const ownership =
                    checkWithdrawalOwnership(
                        bank,
                        parsed
                    );

                if (!ownership.ok) {
                    return interaction.reply({
                        content:
                            `❌ **Cannot approve.**\n\n${ownership.reason}\n\n` +
                            `The request will remain pending so a Bank Owner can handle it later.`,
                        ephemeral: true
                    });
                }

                removeWithdrawalItems(
                    bank,
                    parsed
                );

                request.status =
                    "approved";

                request.approvedBy =
                    interaction.user.id;

                request.completedAt =
                    Date.now();

                request.parsed =
                    parsed;

                saveData();

                try {
                    const user =
                        await client.users.fetch(
                            request.userId
                        );

                    await user.send(
                        `✅ **Your withdrawal was approved!**\n\n` +
                        `🏦 Source: **${request.source === "league_bank" ? "League Bank" : "Personal Bank"}**\n` +
                        `💰 ${request.amount}\n` +
                        `🎮 Roblox: **${request.robloxUsername}**\n` +
                        `📝 Reason: ${request.reason}\n\n` +
                        `📬 Check your mail soon!`
                    );
                } catch (error) {
                    console.error(
                        "Could not DM user:",
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
                                `✅ <@${request.userId}>, your withdrawal was **approved**!\n📬 Check your mail soon.`,
                            allowedMentions: {
                                users: [
                                    request.userId
                                ]
                            }
                        });
                    }
                } catch (error) {
                    console.error(
                        "Could not send approval:",
                        error.message
                    );
                }

                return interaction.update({
                    content:
                        "✅ **Withdrawal approved successfully.**",
                    embeds: [],
                    components: []
                });
            }

            // =================================================
            // REJECT
            // BANK OWNER ONLY
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

                const found =
                    findWithdrawalRequest(
                        requestId
                    );

                if (!found) {
                    return interaction.reply({
                        content:
                            "❌ Request no longer exists.",
                        ephemeral: true
                    });
                }

                const {
                    guildId,
                    request
                } = found;

                const owner =
                    await isBankOwner(
                        interaction.user.id,
                        guildId
                    );

                if (!owner) {
                    return interaction.reply({
                        content:
                            "❌ You are not a Bank Owner.",
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
                            "Rejection Reason"
                        )
                        .setStyle(
                            TextInputStyle.Paragraph
                        )
                        .setPlaceholder(
                            "Why are you rejecting this?"
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

        // ====================================================
        // MODALS
        // ====================================================

        if (interaction.isModalSubmit()) {

            // =================================================
            // LEAGUE BANK WITHDRAW MODAL
            // ANY MEMBER CAN SUBMIT
            // =================================================

            if (
                interaction.customId ===
                "bank_withdraw_modal"
            ) {

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
                            "❌ You already have an open withdrawal.",
                        ephemeral: true
                    });
                }

                const amount =
                    interaction.fields.getTextInputValue(
                        "bank_withdraw_amount"
                    );

                const robloxUsername =
                    interaction.fields.getTextInputValue(
                        "bank_withdraw_roblox"
                    );

                const reason =
                    interaction.fields.getTextInputValue(
                        "bank_withdraw_reason"
                    );

                if (!reason.trim()) {
                    return interaction.reply({
                        content:
                            "❌ A reason is required.",
                        ephemeral: true
                    });
                }

                const parsed =
                    parseWithdrawalRequest(
                        amount
                    );

                if (
                    parsed.gems <= 0 &&
                    parsed.items.length === 0 &&
                    parsed.titanics <= 0
                ) {
                    return interaction.reply({
                        content:
                            "❌ I couldn't understand what you're requesting.",
                        ephemeral: true
                    });
                }

                // League Bank does not contain Titanics
                if (parsed.titanics > 0) {
                    return interaction.reply({
                        content:
                            "❌ Titanics cannot currently be withdrawn from the League Bank.",
                        ephemeral: true
                    });
                }

                // =================================================
                // NO BANK OWNERSHIP CHECK HERE.
                // ANY MEMBER CAN SUBMIT.
                // =================================================

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
                    robloxUsername:
                        robloxUsername,
                    amount:
                        amount,
                    reason:
                        reason,
                    source:
                        "league_bank",
                    status:
                        "pending",
                    createdAt:
                        Date.now(),
                    ownerIds:
                        []
                };

                guildData.withdrawals[
                    requestId
                ] = request;

                saveData();

                await interaction.reply({
                    content:
                        "✅ **League Bank withdrawal submitted!**\n\n" +
                        "🏦 Bank Owners have been notified.\n" +
                        "⏳ Waiting for approval.",
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
            // PERSONAL WITHDRAW MODAL
            // ANY MEMBER CAN SUBMIT
            // =================================================

            if (
                interaction.customId ===
                "withdraw_modal"
            ) {

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
                            "❌ You already have an open withdrawal.",
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

                const reason =
                    interaction.fields.getTextInputValue(
                        "withdraw_reason"
                    );

                if (!reason.trim()) {
                    return interaction.reply({
                        content:
                            "❌ A reason is required.",
                        ephemeral: true
                    });
                }

                const parsed =
                    parseWithdrawalRequest(
                        amount
                    );

                if (
                    parsed.gems <= 0 &&
                    parsed.items.length === 0 &&
                    parsed.titanics <= 0
                ) {
                    return interaction.reply({
                        content:
                            "❌ I couldn't understand what you're requesting.",
                        ephemeral: true
                    });
                }

                // =================================================
                // NO PERSONAL BANK OWNERSHIP CHECK HERE.
                // ANY MEMBER CAN SUBMIT.
                // BANK IS CHECKED WHEN OWNER APPROVES.
                // =================================================

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
                    robloxUsername:
                        robloxUsername,
                    amount:
                        amount,
                    reason:
                        reason,
                    source:
                        "personal_bank",
                    status:
                        "pending",
                    createdAt:
                        Date.now(),
                    ownerIds:
                        []
                };

                guildData.withdrawals[
                    requestId
                ] = request;

                saveData();

                await interaction.reply({
                    content:
                        "✅ **Withdrawal submitted!**\n\n" +
                        "🏦 Bank Owners have been notified.\n" +
                        "⏳ Waiting for approval.",
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
            // REJECTION MODAL
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

                const found =
                    findWithdrawalRequest(
                        requestId
                    );

                if (!found) {
                    return interaction.reply({
                        content:
                            "❌ Request no longer exists.",
                        ephemeral: true
                    });
                }

                const {
                    guildId,
                    request
                } = found;

                const owner =
                    await isBankOwner(
                        interaction.user.id,
                        guildId
                    );

                if (!owner) {
                    return interaction.reply({
                        content:
                            "❌ You are not a Bank Owner.",
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
                        `🏦 Source: **${request.source === "league_bank" ? "League Bank" : "Personal Bank"}**\n` +
                        `💰 Requested: **${request.amount}**\n` +
                        `📝 Your reason: ${request.reason}\n\n` +
                        `❌ **Rejection reason:** ${reason}`
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
                                `❌ <@${request.userId}>, your withdrawal was **rejected**.\n📝 Reason: ${reason}`,
                            allowedMentions: {
                                users: [
                                    request.userId
                                ]
                            }
                        });
                    }
                } catch (error) {
                    console.error(
                        "Could not send rejection:",
                        error.message
                    );
                }

                return interaction.update({
                    content:
                        "❌ **Withdrawal rejected. User notified.**",
                    embeds: [],
                    components: []
                });
            }
        }
    }
);

// ============================================================
// TRACKER
// ============================================================

async function runTracker() {

    console.log(
        `[${new Date().toLocaleString()}] Checking players...`
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

        if (!guild) continue;

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
                    result.status ===
                    "LEAGUE_NOT_DISCOVERED"
                ) {
                    continue;
                }

                if (
                    result.status ===
                    "PLAYER_NOT_FOUND"
                ) {
                    continue;
                }

                if (result.gain === null) {
                    continue;
                }

                if (result.gain > 0) {
                    continue;
                }

                if (result.timestampChanged) {
                    continue;
                }

                if (
                    result.unchangedChecks < 2
                ) {
                    continue;
                }

                const channel =
                    guild.channels.cache.get(
                        tracked.channelId
                    );

                if (!channel) continue;

                await channel.send({
                    content:
                        `🚨 <@${tracked.discordUserId}>\n\n` +
                        `**LOCK IN GET ON** 🔒\n\n` +
                        `🏆 League: **${result.leagueName}**\n` +
                        `📊 Rank: **#${result.leagueRank}**\n` +
                        `⭐ Points: **${result.leaguePoints.toLocaleString()}**\n\n` +
                        `⚠️ No League Point gain detected for approximately **10+ minutes**.`,
                    allowedMentions: {
                        users: [
                            tracked.discordUserId
                        ]
                    }
                });

            } catch (error) {

                console.error(
                    `❌ Tracker error for ${tracked.username}:`,
                    error.message
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
