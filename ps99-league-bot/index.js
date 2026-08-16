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

// YOUR BANK OWNER ROLE
const BANK_ROLE_ID = "1532984876826103889";

// IMPORTANT:
// Only Guilds is needed.
// GuildMembers is a privileged intent and was causing:
// "Error: Used disallowed intents"
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds
    ]
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
        console.error(
            "⚠️ Could not read data.json:",
            error.message
        );
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
        console.error(
            "❌ Could not save data.json:",
            error.message
        );
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

    const bank = guildData.personalBanks[userId];

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
// BANK OWNER CHECK
// ============================================================

async function isBankOwner(userId, guildId) {
    if (!guildId) {
        return false;
    }

    try {
        const guild = client.guilds.cache.get(guildId);

        if (!guild) {
            return false;
        }

        // REST fetch works without the privileged GuildMembers intent.
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

    return interaction.member.roles.cache.has(
        BANK_ROLE_ID
    );
}

async function denyPermission(interaction) {
    if (interaction.replied || interaction.deferred) {
        return interaction.followUp({
            content:
                "❌ You don't have permission to use this.",
            ephemeral: true
        });
    }

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
    const response = await fetch(url, options);

    let body = null;

    try {
        body = await response.json();
    } catch {
        // No JSON
    }

    if (!response.ok) {
        const errorMessage =
            body?.error?.message ||
            body?.message ||
            `HTTP ${response.status}`;

        const error = new Error(errorMessage);
        error.status = response.status;

        throw error;
    }

    return body;
}

// ============================================================
// ROBLOX USER
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
// AUTOMATIC LEAGUE
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
                result.data.League?.Name || null,

            leagueId:
                result.data.League?.ID || null,

            leaguePoints:
                Number(result.data.Points || 0),

            timestamp:
                result.data.Timestamp
                    ? Number(result.data.Timestamp)
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
// GET LEAGUE
// ============================================================

async function getLeague(leagueName) {
    return await getJson(
        `${PS99_API}/leagues/${encodeURIComponent(leagueName)}`
    );
}

// ============================================================
// PLAYER FROM LEAGUE
// ============================================================

async function getPlayerFromLeague(
    leagueName,
    robloxUserId
) {
    const response =
        await getLeague(leagueName);

    const league = response.data;

    if (!league) {
        return null;
    }

    const contributions =
        Array.isArray(league.PointContributions)
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

        if (
            discovered &&
            discovered.leagueName
        ) {
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
                status:
                    "PLAYER_NOT_FOUND"
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
                "❌ You need **1 XP** to open this chest.",
            ephemeral: true
        });
    }

    // Take 1 XP
    bank.xp -= 1;

    // 😈 TROLL
    saveData();

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setTitle("🎁 CHEST OPENED!")
                .setDescription(
                    "💀 **FUCK YOU GET TROLLED LMAO**"
                )
                .addFields({
                    name: "⭐ Remaining XP",
                    value:
                        bank.xp.toLocaleString()
                })
        ]
    });
}

// ============================================================
// WITHDRAWAL
// ============================================================

function generateRequestId() {
    return (
        Date.now().toString(36) +
        Math.random()
            .toString(36)
            .substring(2, 8)
    );
}

function getOpenWithdrawal(
    guildData,
    userId
) {
    return Object.values(
        guildData.withdrawals || {}
    ).find(
        request =>
            request.userId === userId &&
            request.status === "pending"
    );
}

function parseWithdrawalRequest(text) {
    const result = {
        gems: 0,
        items: [],
        titanics: 0
    };

    const lower =
        text.toLowerCase();

    const gemMatch =
        lower.match(
            /([\d,.]+)\s*(k|m|b|t)?\s*(?:gems?|diamonds?)/i
        );

    if (gemMatch) {
        let amount =
            Number(
                gemMatch[1]
                    .replace(/,/g, "")
            );

        const suffix =
            gemMatch[2];

        if (suffix === "k") {
            amount *= 1_000;
        }

        if (suffix === "m") {
            amount *= 1_000_000;
        }

        if (suffix === "b") {
            amount *= 1_000_000_000;
        }

        if (suffix === "t") {
            amount *= 1_000_000_000_000;
        }

        result.gems =
            Math.floor(amount);
    }

    const hugeMatch =
        lower.match(
            /(\d+)\s*(?:x\s*)?(?:random\s+huge|huge)/i
        );

    if (hugeMatch) {
        result.items.push({
            name: "Random Huge",
            amount:
                Number(hugeMatch[1])
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

    return result;
}

function checkWithdrawalOwnership(
    bank,
    parsed
) {
    if (
        parsed.gems >
        bank.gems
    ) {
        return {
            ok: false,
            reason:
                `The user requested ${parsed.gems.toLocaleString()} gems but only has ${bank.gems.toLocaleString()} gems.`
        };
    }

    if (
        parsed.titanics >
        bank.titanics.length
    ) {
        return {
            ok: false,
            reason:
                `The user requested ${parsed.titanics} TITANIC(s) but only has ${bank.titanics.length}.`
        };
    }

    for (
        const requested of
        parsed.items
    ) {
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
                    `The user requested ${requested.amount}x ${requested.name}, but they don't have enough.`
            };
        }
    }

    return {
        ok: true
    };
}

function removeWithdrawalItems(
    bank,
    parsed
) {
    bank.gems -=
        parsed.gems;

    for (
        const requested of
        parsed.items
    ) {
        const existing =
            bank.items.find(
                item =>
                    item.name.toLowerCase() ===
                    requested.name.toLowerCase()
            );

        if (existing) {
            existing.amount -=
                requested.amount;

            if (
                existing.amount <= 0
            ) {
                bank.items =
                    bank.items.filter(
                        item =>
                            item !== existing
                    );
            }
        }
    }

    for (
        let i = 0;
        i < parsed.titanics;
        i++
    ) {
        bank.titanics.shift();
    }
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
                    guildData.withdrawals[
                        requestId
                    ]
            };
        }
    }

    return null;
}

// ============================================================
// NOTIFY BANK OWNERS
// ============================================================

async function notifyWithdrawalOwners(
    guild,
    request
) {
    try {
        // Fetch members through REST.
        // This avoids needing the privileged GuildMembers intent.
        const members =
            await guild.members.fetch();

        const owners =
            members.filter(
                member =>
                    member.roles.cache.has(
                        BANK_ROLE_ID
                    )
            );

        if (owners.size === 0) {
            console.error(
                "❌ No Bank Owners found."
            );

            return [];
        }

        const ownerIds = [];

        for (
            const member of
            owners.values()
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
                                name: "💰 Requested",
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

    } catch (error) {
        console.error(
            "Could not fetch bank owners:",
            error.message
        );

        return [];
    }
}

// ============================================================
// COMMANDS
// ============================================================

const commands = [

    // TRACKER
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

    // XP
    new SlashCommandBuilder()
        .setName("xp")
        .setDescription(
            "Check your XP"
        ),

    new SlashCommandBuilder()
        .setName("givexp")
        .setDescription(
            "Give XP to one member"
        )
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription(
                    "Member"
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
            "Give XP to every member"
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
        .setName("addxp")
        .setDescription(
            "Add XP to a member's personal bank"
        )
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription(
                    "Member"
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
        .setName("removexp")
        .setDescription(
            "Remove XP from a member's personal bank"
        )
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription(
                    "Member"
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

    // GEMS
    new SlashCommandBuilder()
        .setName("addgems")
        .setDescription(
            "Add gems to a member's personal bank"
        )
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription(
                    "Member"
                )
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option
                .setName("amount")
                .setDescription(
                    "Gem amount"
                )
                .setMinValue(1)
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("removegems")
        .setDescription(
            "Remove gems from a member's personal bank"
        )
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription(
                    "Member"
                )
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option
                .setName("amount")
                .setDescription(
                    "Gem amount"
                )
                .setMinValue(1)
                .setRequired(true)
        ),

    // ITEMS
    new SlashCommandBuilder()
        .setName("additem")
        .setDescription(
            "Add an item to a member's personal bank"
        )
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription(
                    "Member"
                )
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("item")
                .setDescription(
                    "Item name"
                )
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option
                .setName("amount")
                .setDescription(
                    "Item quantity"
                )
                .setMinValue(1)
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("removeitem")
        .setDescription(
            "Remove an item from a member's personal bank"
        )
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription(
                    "Member"
                )
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("item")
                .setDescription(
                    "Item name"
                )
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option
                .setName("amount")
                .setDescription(
                    "Item quantity"
                )
                .setMinValue(1)
                .setRequired(true)
        ),

    // CHEST
    new SlashCommandBuilder()
        .setName("chest")
        .setDescription(
            "View the chest and its odds"
        ),

    // BANK
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
        ),

    new SlashCommandBuilder()
        .setName("factoryreset")
        .setDescription(
            "Remove all tracked players"
        ),

    // PERSONAL BANK
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
// READY
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
    }
);

// ============================================================
// INTERACTIONS
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
                        `⚠️ The PS99 API couldn't identify their League yet.\n\n` +
                        `The bot will keep trying automatically.`
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
                                `🏆 League: **Still searching...**`
                            );

                            continue;
                        }

                        if (
                            result.status ===
                            "PLAYER_NOT_FOUND"
                        ) {

                            results.push(
                                `👤 **${tracked.username}**\n` +
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
                            `🔄 Timestamp Changed: **${result.timestampChanged ? "Yes" : "No"}**\n` +
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

                return interaction.reply(
                    `⭐ **Your XP:** ${bank.xp.toLocaleString()}`
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

                bank.xp += amount;

                saveData();

                return interaction.reply(
                    `✅ Gave <@${user.id}> **${amount.toLocaleString()} XP**.\n\n` +
                    `⭐ New XP balance: **${bank.xp.toLocaleString()} XP**`
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

                await interaction.deferReply();

                try {

                    const members =
                        await interaction.guild.members.fetch();

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

                        bank.xp += amount;

                        count++;
                    }

                    saveData();

                    return interaction.editReply(
                        `✅ **Gave ${amount.toLocaleString()} XP to everyone!**\n\n` +
                        `👥 Members given XP: **${count}**\n` +
                        `⭐ XP per member: **${amount.toLocaleString()}**`
                    );

                } catch (error) {

                    console.error(
                        "Give XP all error:",
                        error
                    );

                    return interaction.editReply(
                        "❌ I couldn't give XP to all members."
                    );
                }
            }

            // =================================================
            // ADD XP
            // =================================================

            if (
                interaction.commandName ===
                "addxp"
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

                bank.xp += amount;

                saveData();

                return interaction.reply(
                    `✅ Added **${amount.toLocaleString()} XP** to <@${user.id}>'s personal bank.\n\n` +
                    `⭐ New balance: **${bank.xp.toLocaleString()} XP**`
                );
            }

            // =================================================
            // REMOVE XP
            // =================================================

            if (
                interaction.commandName ===
                "removexp"
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

                if (
                    amount >
                    bank.xp
                ) {
                    return interaction.reply({
                        content:
                            `❌ <@${user.id}> only has **${bank.xp.toLocaleString()} XP**.`,
                        ephemeral: true
                    });
                }

                bank.xp -= amount;

                saveData();

                return interaction.reply(
                    `✅ Removed **${amount.toLocaleString()} XP** from <@${user.id}>'s personal bank.\n\n` +
                    `⭐ New balance: **${bank.xp.toLocaleString()} XP**`
                );
            }

            // =================================================
            // ADD GEMS
            // =================================================

            if (
                interaction.commandName ===
                "addgems"
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

                bank.gems += amount;

                saveData();

                return interaction.reply(
                    `✅ Added **${amount.toLocaleString()} gems** to <@${user.id}>'s personal bank.\n\n` +
                    `💎 New balance: **${bank.gems.toLocaleString()} gems**`
                );
            }

            // =================================================
            // REMOVE GEMS
            // =================================================

            if (
                interaction.commandName ===
                "removegems"
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

                if (
                    amount >
                    bank.gems
                ) {
                    return interaction.reply({
                        content:
                            `❌ <@${user.id}> only has **${bank.gems.toLocaleString()} gems**.`,
                        ephemeral: true
                    });
                }

                bank.gems -= amount;

                saveData();

                return interaction.reply(
                    `✅ Removed **${amount.toLocaleString()} gems** from <@${user.id}>'s personal bank.\n\n` +
                    `💎 New balance: **${bank.gems.toLocaleString()} gems**`
                );
            }

            // =================================================
            // ADD ITEM
            // =================================================

            if (
                interaction.commandName ===
                "additem"
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

                const itemName =
                    interaction.options.getString(
                        "item"
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

                const existing =
                    bank.items.find(
                        item =>
                            item.name.toLowerCase() ===
                            itemName.toLowerCase()
                    );

                if (existing) {
                    existing.amount += amount;
                } else {
                    bank.items.push({
                        name:
                            itemName,
                        amount
                    });
                }

                saveData();

                return interaction.reply(
                    `✅ Added **${amount}x ${itemName}** to <@${user.id}>'s personal bank.`
                );
            }

            // =================================================
            // REMOVE ITEM
            // =================================================

            if (
                interaction.commandName ===
                "removeitem"
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

                const itemName =
                    interaction.options.getString(
                        "item"
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

                const existing =
                    bank.items.find(
                        item =>
                            item.name.toLowerCase() ===
                            itemName.toLowerCase()
                    );

                if (!existing) {
                    return interaction.reply({
                        content:
                            `❌ <@${user.id}> doesn't have **${itemName}**.`,
                        ephemeral: true
                    });
                }

                if (
                    existing.amount <
                    amount
                ) {
                    return interaction.reply({
                        content:
                            `❌ <@${user.id}> only has **${existing.amount}x ${itemName}**.`,
                        ephemeral: true
                    });
                }

                existing.amount -= amount;

                if (
                    existing.amount <= 0
                ) {
                    bank.items =
                        bank.items.filter(
                            item =>
                                item !== existing
                        );
                }

                saveData();

                return interaction.reply(
                    `✅ Removed **${amount}x ${itemName}** from <@${user.id}>'s personal bank.`
                );
            }

            // =================================================
            // CHEST
            // =================================================

            if (
                interaction.commandName ===
                "chest"
            ) {

                const button =
                    new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId(
                                    "open_chest"
                                )
                                .setLabel(
                                    "Open Chest — 1 XP"
                                )
                                .setEmoji(
                                    "🎁"
                                )
                                .setStyle(
                                    ButtonStyle.Primary
                                )
                        );

                return interaction.reply({
                    embeds: [
                        chestEmbed()
                    ],
                    components: [
                        button
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

                const itemsText =
                    bank.items.length > 0
                        ? bank.items
                            .map(
                                item =>
                                    `• **${item.name}** × ${item.amount}`
                            )
                            .join("\n")
                        : "None";

                const titanicsText =
                    bank.titanics.length > 0
                        ? bank.titanics
                            .map(
                                item =>
                                    `• **${item}**`
                            )
                            .join("\n")
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
                                    name: "🐾 Huge / Items",
                                    value:
                                        itemsText,
                                    inline: false
                                },
                                {
                                    name: "🚨 Titanics",
                                    value:
                                        titanicsText,
                                    inline: false
                                }
                            )
                    ]
                });
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

                const itemsText =
                    bank.items.length > 0
                        ? bank.items
                            .map(
                                item =>
                                    `• **${item.name}** × ${item.amount}`
                            )
                            .join("\n")
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
                                    value:
                                        itemsText
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
                    existing.amount += amount;
                } else {
                    guildData.bank.items.push({
                        name:
                            itemName,
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
                    existing.amount <
                    amount
                ) {
                    return interaction.reply({
                        content:
                            "❌ The League Bank doesn't have enough of that item.",
                        ephemeral: true
                    });
                }

                existing.amount -= amount;

                if (
                    existing.amount <= 0
                ) {
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
                    `Removed **${count}** tracked player(s).\n\n` +
                    `🏦 Personal banks and XP were **NOT changed**.`
                );
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
                            "What do you want?"
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

                modal.addComponents(
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
        // BUTTONS
        // ====================================================

        if (
            interaction.isButton()
        ) {

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
                            "❌ You need **1 XP** to open this chest.",
                        ephemeral: true
                    });
                }

                bank.xp -= 1;

                const reward =
                    rollChestReward();

                if (
                    reward.type ===
                    "gems"
                ) {

                    bank.gems +=
                        reward.amount;

                    saveData();

                    return interaction.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setTitle(
                                    "🎁 CHEST OPENED!"
                                )
                                .setDescription(
                                    `You used **1 XP** and won **${reward.amount.toLocaleString()} gems!** 💎`
                                )
                                .addFields({
                                    name:
                                        "⭐ Remaining XP",
                                    value:
                                        bank.xp.toLocaleString()
                                })
                        ]
                    });
                }

                if (
                    reward.type ===
                    "huge"
                ) {

                    bank.items.push({
                        name:
                            "Random Huge",
                        amount: 1
                    });

                    saveData();

                    return interaction.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setTitle(
                                    "🎁 CHEST OPENED!"
                                )
                                .setDescription(
                                    "🐾 **YOU WON A RANDOM HUGE!**"
                                )
                                .addFields({
                                    name:
                                        "⭐ Remaining XP",
                                    value:
                                        bank.xp.toLocaleString()
                                })
                        ]
                    });
                }

                bank.titanics.push(
                    "TITANIC"
                );

                saveData();

                return interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle(
                                "🚨🚨🚨 TITANIC! 🚨🚨🚨"
                            )
                            .setDescription(
                                "YOU JUST HIT THE **0.1% TITANIC!**"
                            )
                            .addFields({
                                name:
                                    "⭐ Remaining XP",
                                value:
                                    bank.xp.toLocaleString()
                            })
                    ]
                });
            }

            // =================================================
            // APPROVE
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
                            "❌ That withdrawal request no longer exists.",
                        ephemeral: true
                    });
                }

                const {
                    guildId,
                    guildData,
                    request
                } = found;

                // CRITICAL:
                // Check the owner's role in the ORIGINAL SERVER.
                const owner =
                    await isBankOwner(
                        interaction.user.id,
                        guildId
                    );

                if (!owner) {
                    return interaction.reply({
                        content:
                            "❌ You are not a Bank Owner for this server.",
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

                const parsed =
                    parseWithdrawalRequest(
                        request.amount
                    );

                const ownership =
                    checkWithdrawalOwnership(
                        bank,
                        parsed
                    );

                if (!ownership.ok) {
                    return interaction.reply({
                        content:
                            `❌ **Cannot approve this withdrawal.**\n\n${ownership.reason}`,
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
                                `✅ <@${request.userId}>, your withdrawal request was **approved**!\n📬 Check your mail soon.`,

                            allowedMentions: {
                                users: [
                                    request.userId
                                ]
                            }
                        });
                    }

                } catch (error) {

                    console.error(
                        "Could not send approval message:",
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
                            "❌ That withdrawal request no longer exists.",
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
                            "❌ You are not a Bank Owner for this server.",
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
                            "Reason"
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
                            "❌ Use this inside a server.",
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
                            "❌ I couldn't understand what you're requesting.\n\nExample: `25m gems, 1 Random Huge, 1 TITANIC`",
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
            // REJECT MODAL
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
                            "❌ That request no longer exists.",
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
                            "❌ You are not a Bank Owner for this server.",
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
                                `❌ <@${request.userId}>, your withdrawal request was **rejected**.\n📝 **Reason:** ${reason}`,

                            allowedMentions: {
                                users: [
                                    request.userId
                                ]
                            }
                        });
                    }

                } catch (error) {

                    console.error(
                        "Could not send rejection message:",
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

                if (
                    result.status ===
                    "LEAGUE_NOT_DISCOVERED"
                ) {

                    console.log(
                        `🔎 ${tracked.username}: League not discovered yet`
                    );

                    continue;
                }

                if (
                    result.status ===
                    "PLAYER_NOT_FOUND"
                ) {

                    console.log(
                        `⚠️ ${tracked.username}: contribution not found`
                    );

                    continue;
                }

                if (
                    result.gain ===
                    null
                ) {

                    console.log(
                        `📌 ${tracked.username}: baseline established`
                    );

                    continue;
                }

                if (
                    result.gain > 0
                ) {

                    console.log(
                        `✅ ${tracked.username}: +${result.gain} LP`
                    );

                    continue;
                }

                if (
                    result.timestampChanged
                ) {

                    console.log(
                        `🔄 ${tracked.username}: new contribution timestamp`
                    );

                    continue;
                }

                if (
                    result.unchangedChecks < 2
                ) {

                    console.log(
                        `⏳ ${tracked.username}: ${result.unchangedChecks}/2 unchanged checks`
                    );

                    continue;
                }

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
