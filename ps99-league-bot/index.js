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

// Bank/owner role
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
    } catch (error) {
        console.error("⚠️ Could not read data.json");
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
            personalBanks: {},
            withdrawals: {}
        };
    }

    if (!Array.isArray(data[guildId].users)) {
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

    if (!data[guildId].personalBanks) {
        data[guildId].personalBanks = {};
    }

    if (!data[guildId].withdrawals) {
        data[guildId].withdrawals = {};
    }

    return data[guildId];
}

// ============================================================
// PERSONAL BANK
// ============================================================

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

    const bank =
        guildData.personalBanks[userId];

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

    const response =
        await fetch(
            url,
            options
        );

    let body = null;

    try {
        body = await response.json();
    } catch {
        // Nothing
    }

    if (!response.ok) {

        const error =
            body?.error?.message ||
            body?.message ||
            `HTTP ${response.status}`;

        const err =
            new Error(error);

        err.status =
            response.status;

        throw err;
    }

    return body;
}

// ============================================================
// ROBLOX USER LOOKUP
// ============================================================

async function findRobloxUser(username) {

    const result =
        await getJson(
            `${ROBLOX_API}/usernames/users`,
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json"
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

    const user =
        result.data[0];

    return {
        userId:
            Number(user.id),

        username:
            user.name,

        displayName:
            user.displayName
    };
}

// ============================================================
// AUTOMATIC LEAGUE DISCOVERY
// ============================================================

async function findPlayerLeague(robloxUserId) {

    try {

        const result =
            await getJson(
                `${PS99_API}/leagues/players/${robloxUserId}`
            );

        if (!result.data) {
            return null;
        }

        return {

            leagueName:
                result.data.League?.Name ||
                null,

            leagueId:
                result.data.League?.ID ||
                null,

            leaguePoints:
                Number(
                    result.data.Points || 0
                ),

            timestamp:
                result.data.Timestamp
                    ? Number(
                        result.data.Timestamp
                    )
                    : null
        };

    } catch (error) {

        if (error.status === 404) {
            return null;
        }

        throw error;
    }
}

// ============================================================
// GET FULL LEAGUE
// ============================================================

async function getLeague(leagueName) {

    return await getJson(
        `${PS99_API}/leagues/${encodeURIComponent(
            leagueName
        )}`
    );
}

// ============================================================
// GET PLAYER FROM LEAGUE
// ============================================================

async function getPlayerFromLeague(
    leagueName,
    robloxUserId
) {

    const response =
        await getLeague(
            leagueName
        );

    const league =
        response.data;

    if (!league) {
        return null;
    }

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
                Number(robloxUserId)
        );

    if (index === -1) {
        return null;
    }

    const player =
        contributions[index];

    return {

        leagueName:
            league.Name,

        leagueId:
            league.ID,

        leaguePoints:
            Number(player.Points || 0),

        leagueRank:
            index + 1,

        timestamp:
            player.Timestamp
                ? Number(player.Timestamp)
                : null
    };
}

// ============================================================
// CHECK PLAYER
// ============================================================

async function checkPlayer(tracked) {

    if (!tracked.leagueName) {

        const discovered =
            await findPlayerLeague(
                tracked.robloxUserId
            );

        if (!discovered) {

            return {
                status:
                    "LEAGUE_NOT_DISCOVERED"
            };
        }

        tracked.leagueName =
            discovered.leagueName;

        tracked.leagueId =
            discovered.leagueId;
    }

    const result =
        await getPlayerFromLeague(
            tracked.leagueName,
            tracked.robloxUserId
        );

    if (!result) {

        const discovered =
            await findPlayerLeague(
                tracked.robloxUserId
            );

        if (
            discovered &&
            discovered.leagueName &&
            discovered.leagueName !==
                tracked.leagueName
        ) {

            tracked.leagueName =
                discovered.leagueName;

            tracked.leagueId =
                discovered.leagueId;

            const retry =
                await getPlayerFromLeague(
                    tracked.leagueName,
                    tracked.robloxUserId
                );

            if (!retry) {
                return {
                    status:
                        "PLAYER_NOT_FOUND"
                };
            }

            return processLeagueResult(
                tracked,
                retry
            );
        }

        return {
            status:
                "PLAYER_NOT_FOUND"
        };
    }

    return processLeagueResult(
        tracked,
        result
    );
}

// ============================================================
// PROCESS LEAGUE RESULT
// ============================================================

function processLeagueResult(
    tracked,
    result
) {

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

    // ========================================================
    // INACTIVITY TRACKING
    // ========================================================

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

    // ========================================================
    // SAVE
    // ========================================================

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

        status:
            "OK",

        leagueName:
            result.leagueName,

        leaguePoints:
            result.leaguePoints,

        leagueRank:
            result.leagueRank,

        timestamp:
            result.timestamp,

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
// CHEST ODDS
// ============================================================

const CHEST_ODDS = [

    {
        type: "huge",
        name: "🐾 Random Huge",
        chance: 50
    },

    {
        type: "gems",
        name: "💎 25,000,000 Gems",
        chance: 25
    },

    {
        type: "gems",
        name: "💎 45,000,000 Gems",
        chance: 15
    },

    {
        type: "gems",
        name: "💎 100,000,000 Gems",
        chance: 5
    },

    {
        type: "gems",
        name: "💎 250,000,000 Gems",
        chance: 3
    },

    {
        type: "gems",
        name: "💎 300,000,000 Gems",
        chance: 1.9
    },

    {
        type: "titanic",
        name: "🚨 TITANIC",
        chance: 0.1
    }

];

function rollChestReward() {

    const roll =
        Math.random() * 100;

    let current = 0;

    for (
        const reward of
        CHEST_ODDS
    ) {

        current +=
            reward.chance;

        if (
            roll < current
        ) {
            return reward;
        }
    }

    return CHEST_ODDS[
        CHEST_ODDS.length - 1
    ];
}

// ============================================================
// CHEST EMBED
// ============================================================

function createChestEmbed(xp) {

    const oddsText =
        CHEST_ODDS
            .map(
                reward =>
                    `${reward.name} — **${reward.chance}%**`
            )
            .join("\n");

    return new EmbedBuilder()
        .setTitle("🎁 PS99 League Chest")
        .setDescription(
            `Spend **1 XP** to open this chest.\n\n` +
            `⭐ **Your XP:** ${xp.toLocaleString()}\n\n` +
            `**🎲 Chest Odds**\n${oddsText}`
        )
        .setFooter({
            text:
                "Good luck! 🍀"
        });
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
// PARSE WITHDRAWAL
// ============================================================

function parseNumber(value) {

    const cleaned =
        value
            .toLowerCase()
            .replace(/,/g, "")
            .trim();

    const match =
        cleaned.match(
            /^([\d.]+)\s*(k|m|b|t)?$/
        );

    if (!match) {
        return null;
    }

    let number =
        Number(match[1]);

    if (!Number.isFinite(number)) {
        return null;
    }

    const suffix =
        match[2];

    if (suffix === "k") {
        number *= 1000;
    }

    if (suffix === "m") {
        number *= 1000000;
    }

    if (suffix === "b") {
        number *= 1000000000;
    }

    if (suffix === "t") {
        number *= 1000000000000;
    }

    return Math.floor(number);
}

function parseWithdrawalRequest(text) {

    const normalized =
        text
            .trim()
            .toLowerCase();

    const result = {
        gems: 0,
        items: [],
        titanics: 0
    };

    // ========================================================
    // GEMS
    // ========================================================

    const gemMatch =
        normalized.match(
            /([\d,.]+)\s*(k|m|b|t)?\s*(?:gems?|diamonds?)/i
        );

    if (gemMatch) {

        let gemValue =
            `${gemMatch[1]}${gemMatch[2] || ""}`;

        const parsed =
            parseNumber(
                gemValue
            );

        if (parsed) {
            result.gems =
                parsed;
        }
    }

    // ========================================================
    // TITANIC
    // ========================================================

    const titanicMatch =
        normalized.match(
            /(\d+)\s*(?:x\s*)?titanics?/i
        );

    if (titanicMatch) {

        result.titanics =
            Number(
                titanicMatch[1]
            );
    } else if (
        normalized.includes("titanic")
    ) {

        result.titanics = 1;
    }

    // ========================================================
    // HUGE
    // ========================================================

    const hugeMatch =
        normalized.match(
            /(\d+)\s*(?:x\s*)?(?:random\s+)?huge/i
        );

    if (hugeMatch) {

        result.items.push({
            name:
                "Random Huge",

            amount:
                Number(
                    hugeMatch[1]
                )
        });

    } else if (
        normalized.includes("huge")
    ) {

        result.items.push({
            name:
                "Random Huge",

            amount:
                1
        });
    }

    return result;
}

// ============================================================
// CHECK WITHDRAWAL AGAINST BANK
// ============================================================

function validateWithdrawal(
    bank,
    request
) {

    if (
        request.gems > 0 &&
        bank.gems < request.gems
    ) {

        return {
            valid: false,

            reason:
                `You only have **${bank.gems.toLocaleString()} gems**, but requested **${request.gems.toLocaleString()} gems**.`
        };
    }

    if (
        request.titanics > 0 &&
        bank.titanics.length <
            request.titanics
    ) {

        return {
            valid: false,

            reason:
                `You only have **${bank.titanics.length} TITANIC(s)**.`
        };
    }

    for (
        const requested of
        request.items
    ) {

        const item =
            bank.items.find(
                existing =>
                    existing.name.toLowerCase() ===
                    requested.name.toLowerCase()
            );

        if (
            !item ||
            item.amount <
                requested.amount
        ) {

            return {
                valid: false,

                reason:
                    `You don't have enough **${requested.name}**.`
            };
        }
    }

    if (
        request.gems <= 0 &&
        request.titanics <= 0 &&
        request.items.length === 0
    ) {

        return {
            valid: false,

            reason:
                "I couldn't understand what you want to withdraw. Try something like `25m gems`, `1 Random Huge`, or `1 TITANIC`."
        };
    }

    return {
        valid: true
    };
}

// ============================================================
// REMOVE WITHDRAWAL FROM BANK
// ============================================================

function removeWithdrawalFromBank(
    bank,
    request
) {

    if (request.gems > 0) {

        bank.gems -=
            request.gems;
    }

    if (request.titanics > 0) {

        bank.titanics.splice(
            0,
            request.titanics
        );
    }

    for (
        const requested of
        request.items
    ) {

        const item =
            bank.items.find(
                existing =>
                    existing.name.toLowerCase() ===
                    requested.name.toLowerCase()
            );

        if (!item) {
            continue;
        }

        item.amount -=
            requested.amount;

        if (
            item.amount <= 0
        ) {

            bank.items =
                bank.items.filter(
                    existing =>
                        existing.name.toLowerCase() !==
                        requested.name.toLowerCase()
                );
        }
    }
}

// ============================================================
// GET OPEN WITHDRAWAL
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
            `❌ Bank role ${BANK_ROLE_ID} was not found.`
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
    // TRACKER
    // ========================================================

    new SlashCommandBuilder()
        .setName("adduser")
        .setDescription(
            "Add a Roblox player to the tracker"
        )
        .addStringOption(option =>
            option
                .setName("username")
                .setDescription(
                    "Roblox username"
                )
                .setRequired(true)
        )
        .addUserOption(option =>
            option
                .setName("discorduser")
                .setDescription(
                    "Discord user to ping"
                )
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("removeuser")
        .setDescription(
            "Remove a tracked player"
        )
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription(
                    "Discord user"
                )
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("users")
        .setDescription(
            "Show tracked users"
        ),

    new SlashCommandBuilder()
        .setName("check")
        .setDescription(
            "Check all tracked players"
        ),

    new SlashCommandBuilder()
        .setName("lockin")
        .setDescription(
            "Ping a selected user 5 times"
        )
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription(
                    "User to ping"
                )
                .setRequired(true)
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
                        name:
                            "Gems",
                        value:
                            "gems"
                    },
                    {
                        name:
                            "Item",
                        value:
                            "item"
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
                        name:
                            "Gems",
                        value:
                            "gems"
                    },
                    {
                        name:
                            "Item",
                        value:
                            "item"
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
    // XP
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

    new SlashCommandBuilder()
        .setName("givexpall")
        .setDescription(
            "Give XP to everyone in the server"
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
            "View the chest and its odds"
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

].map(
    command =>
        command.toJSON()
);

// ============================================================
// BOT READY
// ============================================================

client.once(
    "ready",
    async () => {

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
                    body:
                        commands
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
    }
);

// ============================================================
// INTERACTION HANDLER
// ============================================================

client.on(
    "interactionCreate",
    async interaction => {

        try {

            // ====================================================
            // SLASH COMMANDS
            // ====================================================

            if (
                interaction.isChatInputCommand()
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

                    const discordUser =
                        interaction.options.getUser(
                            "discorduser"
                        );

                    const already =
                        guildData.users.some(
                            user =>
                                Number(
                                    user.robloxUserId
                                ) > 0 &&
                                user.username?.toLowerCase() ===
                                username.toLowerCase()
                        );

                    if (already) {

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

                            leagueName:
                                null,

                            leagueId:
                                null,

                            lastLeague:
                                null,

                            lastLeaguePoints:
                                null,

                            lastLeagueRank:
                                null,

                            lastContributionTimestamp:
                                null,

                            lastChecked:
                                null,

                            unchangedChecks:
                                0
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

                                `✅ **${roblox.username}** added and tracking started!\n\n` +

                                `👤 Ping: <@${discordUser.id}>\n` +

                                `🏆 League: **${result.leagueName}**\n` +

                                `📊 League Rank: **#${result.leagueRank}**\n` +

                                `⭐ League Points: **${result.leaguePoints.toLocaleString()}**\n\n` +

                                `⏰ Checking every **5 minutes**.`
                            );
                        }

                        return interaction.editReply(

                            `✅ **${roblox.username}** was added.\n\n` +

                            `👤 Ping: <@${discordUser.id}>\n\n` +

                            `⚠️ The PS99 API couldn't automatically identify their League yet.\n\n` +

                            `The bot will keep trying automatically every 5 minutes.`
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

                if (
                    interaction.commandName ===
                    "removeuser"
                ) {

                    const discordUser =
                        interaction.options.getUser(
                            "user"
                        );

                    const before =
                        guildData.users.length;

                    guildData.users =
                        guildData.users.filter(
                            user =>
                                user.discordUserId !==
                                discordUser.id
                        );

                    if (
                        guildData.users.length ===
                        before
                    ) {

                        return interaction.reply({
                            content:
                                "❌ That Discord user isn't being tracked.",
                            ephemeral: true
                        });
                    }

                    saveData();

                    return interaction.reply(
                        `✅ Removed <@${discordUser.id}> from tracking.`
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

                    const list =
                        guildData.users
                            .map(
                                (user, index) => {

                                    const league =
                                        user.leagueName ||
                                        "Searching...";

                                    const rank =
                                        user.lastLeagueRank
                                            ? `#${user.lastLeagueRank}`
                                            : "Unknown";

                                    const points =
                                        user.lastLeaguePoints !==
                                            null &&
                                        user.lastLeaguePoints !==
                                            undefined
                                            ? user.lastLeaguePoints.toLocaleString()
                                            : "Unknown";

                                    return (

                                        `**${index + 1}. ${user.username}**\n` +

                                        `👤 Ping: <@${user.discordUserId}>\n` +

                                        `🏆 League: **${league}**\n` +

                                        `📊 League Rank: **${rank}**\n` +

                                        `⭐ League Points: **${points}**`
                                    );
                                }
                            )
                            .join("\n\n");

                    return interaction.reply(
                        `🏆 **PS99 League Tracker**\n\n${list}`
                    );
                }

                // =================================================
                // CHECK
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

                                    `👤 **${tracked.username}**\n` +

                                    `🏆 League: **Still searching...**\n` +

                                    `⚠️ The API hasn't exposed this player's League yet.`
                                );

                                continue;
                            }

                            if (
                                result.status ===
                                "PLAYER_NOT_FOUND"
                            ) {

                                results.push(

                                    `👤 **${tracked.username}**\n` +

                                    `🏆 League: **${tracked.leagueName || "Unknown"}**\n` +

                                    `⚠️ Player contribution wasn't found.`
                                );

                                continue;
                            }

                            let gainText;

                            if (
                                result.gain ===
                                null
                            ) {

                                gainText =
                                    "Baseline";

                            } else if (
                                result.gain > 0
                            ) {

                                gainText =
                                    `+${result.gain.toLocaleString()}`;

                            } else {

                                gainText =
                                    result.gain.toLocaleString();
                            }

                            results.push(

                                `👤 **${tracked.username}**\n` +

                                `🏆 League: **${result.leagueName}**\n` +

                                `📊 League Rank: **#${result.leagueRank}**\n` +

                                `⭐ League Points: **${result.leaguePoints.toLocaleString()}**\n` +

                                `📈 Points Change: **${gainText}**\n` +

                                `🔄 Contribution Timestamp Changed: **${result.timestampChanged ? "Yes" : "No"}**\n` +

                                `⏱️ Unchanged Checks: **${result.unchangedChecks}**`
                            );

                        } catch (error) {

                            console.error(
                                error
                            );

                            results.push(
                                `❌ **${tracked.username}** — API error.`
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

                if (
                    interaction.commandName ===
                    "lockin"
                ) {

                    const user =
                        interaction.options.getUser(
                            "user"
                        );

                    await interaction.reply({
                        content:
                            "🔒 Sending 5 lock-in pings...",
                        ephemeral: true
                    });

                    for (
                        let i = 0;
                        i < 5;
                        i++
                    ) {

                        await interaction.channel.send({

                            content:
                                `🔒 **LOCK IN GET ON** <@${user.id}>`,

                            allowedMentions: {
                                users: [
                                    user.id
                                ]
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
                // FACTORY RESET
                // =================================================

                if (
                    interaction.commandName ===
                    "factoryreset"
                ) {

                    if (
                        !hasBankRole(
                            interaction
                        )
                    ) {

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
                        `🏦 Personal banks and XP were **NOT changed**.`
                    );
                }

                // =================================================
                // BANK
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

                    if (
                        !hasBankRole(
                            interaction
                        )
                    ) {

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

                    if (
                        !hasBankRole(
                            interaction
                        )
                    ) {

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
                        existing.amount <
                            amount
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

                    const bank =
                        getPersonalBank(
                            guildData,
                            interaction.user.id
                        );

                    saveData();

                    return interaction.reply(
                        `⭐ **Your Chest XP:** ${bank.xp.toLocaleString()}`
                    );
                }

                // =================================================
                // GIVE XP
                // =================================================

                if (
                    interaction.commandName ===
                    "givexp"
                ) {

                    if (
                        !hasBankRole(
                            interaction
                        )
                    ) {

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

                    bank.xp +=
                        amount;

                    saveData();

                    return interaction.reply(
                        `✅ Gave <@${user.id}> **${amount.toLocaleString()} XP**.\n\n` +
                        `⭐ New balance: **${bank.xp.toLocaleString()} XP**.`
                    );
                }

                // =================================================
                // GIVE XP ALL
                // =================================================

                if (
                    interaction.commandName ===
                    "givexpall"
                ) {

                    if (
                        !hasBankRole(
                            interaction
                        )
                    ) {

                        return denyPermission(
                            interaction
                        );
                    }

                    const amount =
                        interaction.options.getInteger(
                            "amount"
                        );

                    // IMPORTANT:
                    // Do not fetch every member from Discord.
                    // This keeps the command from getting stuck.
                    //
                    // We give XP to every member already known
                    // by Discord's guild member cache.

                    const members =
                        interaction.guild.members.cache;

                    let count = 0;

                    for (
                        const member of
                        members.values()
                    ) {

                        if (
                            member.user.bot
                        ) {
                            continue;
                        }

                        const bank =
                            getPersonalBank(
                                guildData,
                                member.id
                            );

                        bank.xp +=
                            amount;

                        count++;
                    }

                    saveData();

                    return interaction.reply(
                        `✅ **Gave ${amount.toLocaleString()} XP to ${count} server members.**\n\n` +
                        `⭐ Everyone's XP has been updated.`
                    );
                }

                // =================================================
                // CHEST
                // =================================================

                if (
                    interaction.commandName ===
                    "chest"
                ) {

                    const bank =
                        getPersonalBank(
                            guildData,
                            interaction.user.id
                        );

                    const button =
                        new ButtonBuilder()
                            .setCustomId(
                                "open_chest"
                            )
                            .setLabel(
                                "🎁 Open Chest — 1 XP"
                            )
                            .setStyle(
                                ButtonStyle.Primary
                            );

                    const row =
                        new ActionRowBuilder()
                            .addComponents(
                                button
                            );

                    return interaction.reply({

                        embeds: [
                            createChestEmbed(
                                bank.xp
                            )
                        ],

                        components: [
                            row
                        ]
                    });
                }

                // =================================================
                // MY BANK
                // =================================================

                if (
                    interaction.commandName ===
                    "mybank"
                ) {

                    const bank =
                        getPersonalBank(
                            guildData,
                            interaction.user.id
                        );

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

                    let titanicsText =
                        "None";

                    if (
                        bank.titanics.length > 0
                    ) {

                        titanicsText =
                            bank.titanics
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
                                            bank.xp.toLocaleString(),

                                        inline: true
                                    },

                                    {
                                        name:
                                            "💎 Gems",

                                        value:
                                            bank.gems.toLocaleString(),

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
                                            titanicsText,

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

                    const bank =
                        getPersonalBank(
                            guildData,
                            interaction.user.id
                        );

                    if (
                        bank.gems <= 0 &&
                        bank.items.length === 0 &&
                        bank.titanics.length === 0
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
            // BUTTONS
            // ====================================================

            if (
                interaction.isButton()
            ) {

                // =================================================
                // OPEN CHEST
                // =================================================

                if (
                    interaction.customId ===
                    "open_chest"
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

                    const bank =
                        getPersonalBank(
                            guildData,
                            interaction.user.id
                        );

                    if (
                        bank.xp < 1
                    ) {

                        return interaction.reply({
                            content:
                                "❌ You don't have enough XP. You need **1 XP**.",
                            ephemeral: true
                        });
                    }

                    // Remove XP immediately
                    bank.xp -= 1;

                    const reward =
                        rollChestReward();

                    // =================================================
                    // GEMS
                    // =================================================

                    if (
                        reward.type ===
                        "gems"
                    ) {

                        bank.gems +=
                            reward.amount;

                        saveData();

                        return interaction.reply({

                            content:
                                `🎁 **CHEST OPENED!**\n\n` +
                                `⭐ XP used: **1**\n` +
                                `💎 You won **${reward.amount.toLocaleString()} gems!**\n\n` +
                                `🏦 Added to your personal bank.`,

                            ephemeral: false
                        });
                    }

                    // =================================================
                    // HUGE
                    // =================================================

                    if (
                        reward.type ===
                        "huge"
                    ) {

                        const existing =
                            bank.items.find(
                                item =>
                                    item.name ===
                                    "Random Huge"
                            );

                        if (existing) {

                            existing.amount +=
                                1;

                        } else {

                            bank.items.push({
                                name:
                                    "Random Huge",

                                amount:
                                    1
                            });
                        }

                        saveData();

                        return interaction.reply({

                            content:
                                `🎁 **CHEST OPENED!**\n\n` +
                                `⭐ XP used: **1**\n` +
                                `🐾 You won a **RANDOM HUGE!**\n\n` +
                                `🏦 Added to your personal bank.`,

                            ephemeral: false
                        });
                    }

                    // =================================================
                    // TITANIC
                    // =================================================

                    if (
                        reward.type ===
                        "titanic"
                    ) {

                        bank.titanics.push(
                            "TITANIC"
                        );

                        saveData();

                        return interaction.reply({

                            content:
                                `🚨🚨🚨 **TITANIC!** 🚨🚨🚨\n\n` +
                                `🎁 **CHEST OPENED!**\n` +
                                `⭐ XP used: **1**\n\n` +
                                `🚨 You just pulled a **TITANIC**!\n\n` +
                                `🏦 Added to your personal bank.`,

                            ephemeral: false
                        });
                    }
                }

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

                    let request =
                        null;

                    let guildData =
                        null;

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

                    const bank =
                        getPersonalBank(
                            guildData,
                            request.userId
                        );

                    const validation =
                        validateWithdrawal(
                            bank,
                            request.parsed
                        );

                    if (
                        !validation.valid
                    ) {

                        request.status =
                            "rejected";

                        request.rejectedBy =
                            interaction.user.id;

                        request.rejectionReason =
                            validation.reason;

                        request.completedAt =
                            Date.now();

                        saveData();

                        try {

                            const user =
                                await client.users.fetch(
                                    request.userId
                                );

                            await user.send(
                                `❌ **Your withdrawal request could not be approved.**\n\n` +
                                `💰 **Requested:** ${request.amount}\n\n` +
                                `${validation.reason}`
                            );

                        } catch (error) {

                            console.error(
                                "Could not DM user:",
                                error.message
                            );
                        }

                        return interaction.reply({
                            content:
                                `❌ Cannot approve this request.\n\n${validation.reason}`,
                            ephemeral: true
                        });
                    }

                    // =================================================
                    // REMOVE THE ACTUAL ITEMS/GEMS
                    // =================================================

                    removeWithdrawalFromBank(
                        bank,
                        request.parsed
                    );

                    request.status =
                        "approved";

                    request.approvedBy =
                        interaction.user.id;

                    request.completedAt =
                        Date.now();

                    saveData();

                    // =================================================
                    // USER DM
                    // =================================================

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

                    // =================================================
                    // SERVER NOTIFICATION
                    // =================================================

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
                                    `✅ <@${request.userId}>, your withdrawal request was **approved!**\n` +
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
                            "Could not send approval notification:",
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

                    let request =
                        null;

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

            // ====================================================
            // MODALS
            // ====================================================

            if (
                interaction.isModalSubmit()
            ) {

                // =================================================
                // WITHDRAW MODAL
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

                    const bank =
                        getPersonalBank(
                            guildData,
                            interaction.user.id
                        );

                    const parsed =
                        parseWithdrawalRequest(
                            amount
                        );

                    const validation =
                        validateWithdrawal(
                            bank,
                            parsed
                        );

                    if (
                        !validation.valid
                    ) {

                        return interaction.reply({
                            content:
                                `❌ **Invalid withdrawal:**\n\n${validation.reason}`,
                            ephemeral: true
                        });
                    }

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

                        parsed:
                            parsed,

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
                            "✅ **Withdrawal request submitted!**\n\n" +
                            "🏦 The bank owners have been notified.\n" +
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

                    let request =
                        null;

                    let guildData =
                        null;

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
                            "Could not send rejection notification:",
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

        } catch (error) {

            console.error(
                "❌ Interaction error:",
                error
            );

            try {

                if (
                    interaction.replied ||
                    interaction.deferred
                ) {

                    await interaction.followUp({
                        content:
                            "❌ Something went wrong while processing that.",
                        ephemeral: true
                    });

                } else {

                    await interaction.reply({
                        content:
                            "❌ Something went wrong while processing that.",
                        ephemeral: true
                    });
                }

            } catch {
                // Ignore secondary interaction errors
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

                // =================================================
                // STILL SEARCHING
                // =================================================

                if (
                    result.status ===
                    "LEAGUE_NOT_DISCOVERED"
                ) {

                    console.log(
                        `🔎 ${tracked.username}: League not discovered yet`
                    );

                    continue;
                }

                // =================================================
                // PLAYER NOT FOUND
                // =================================================

                if (
                    result.status ===
                    "PLAYER_NOT_FOUND"
                ) {

                    console.log(
                        `⚠️ ${tracked.username}: contribution not found`
                    );

                    continue;
                }

                // =================================================
                // FIRST CHECK
                // =================================================

                if (
                    result.gain ===
                    null
                ) {

                    console.log(
                        `📌 ${tracked.username}: baseline established`
                    );

                    continue;
                }

                // =================================================
                // GAINED POINTS
                // =================================================

                if (
                    result.gain > 0
                ) {

                    console.log(
                        `✅ ${tracked.username}: +${result.gain} LP`
                    );

                    continue;
                }

                // =================================================
                // TIMESTAMP CHANGED
                // =================================================

                if (
                    result.timestampChanged
                ) {

                    console.log(
                        `🔄 ${tracked.username}: new contribution timestamp`
                    );

                    continue;
                }

                // =================================================
                // REQUIRE TWO UNCHANGED CHECKS
                // =================================================

                if (
                    result.unchangedChecks < 2
                ) {

                    console.log(
                        `⏳ ${tracked.username}: ${result.unchangedChecks}/2 unchanged checks`
                    );

                    continue;
                }

                // =================================================
                // CONFIRMED INACTIVITY
                // =================================================

                const channel =
                    guild.channels.cache.get(
                        tracked.channelId
                    );

                if (!channel) {
                    continue;
                }

                await channel.send({

                    content:

                        `🚨 <@${tracked.discordUserId}>\n\n` +

                        `**LOCK IN GET ON** 🔒\n\n` +

                        `🏆 League: **${result.leagueName}**\n` +

                        `📊 League Rank: **#${result.leagueRank}**\n` +

                        `⭐ League Points: **${result.leaguePoints.toLocaleString()}**\n\n` +

                        `⚠️ No League Point gain detected for approximately **10+ minutes**.`,

                    allowedMentions: {
                        users: [
                            tracked.discordUserId
                        ]
                    }
                });

                console.log(
                    `🚨 ${tracked.username}: inactivity ping sent`
                );

            } catch (error) {

                console.error(
                    `❌ Tracker error for ${tracked.username}:`,
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

    // First check 10 seconds after startup
    setTimeout(
        runTracker,
        10_000
    );

    // Every 5 minutes
    setInterval(
        runTracker,
        5 * 60 * 1000
    );
}

// ============================================================
// LOGIN
// ============================================================

client.login(TOKEN);
