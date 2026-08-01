require("dotenv").config();

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder
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
            users: []
        };
    }

    return data[guildId];
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
// COMMANDS
// ============================================================

const commands = [

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

        if (!interaction.isChatInputCommand()) {
            return;
        }

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

        // ====================================================
        // ADD USER
        // ====================================================

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

        // ====================================================
        // REMOVE USER
        // ====================================================

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

        // ====================================================
        // USERS
        // ====================================================

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

        // ====================================================
        // MANUAL CHECK
        // ====================================================

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
