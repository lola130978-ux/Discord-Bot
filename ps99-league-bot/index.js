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
// GET FULL LEAGUE
// ============================================================

async function getLeague(leagueName) {
    const result = await getJson(
        `${PS99_API}/leagues/${encodeURIComponent(leagueName)}`
    );

    return result.data;
}

// ============================================================
// FIND PLAYER INSIDE SPECIFIED LEAGUE
// ============================================================

async function getPlayerFromLeague(
    leagueName,
    robloxUserId
) {
    const league = await getLeague(leagueName);

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

    const player = contributions[index];

    return {
        leagueName: league.Name,

        leaguePoints:
            Number(player.Points || 0),

        leagueRank:
            index + 1
    };
}

// ============================================================
// CHECK TRACKED USER
// ============================================================

async function checkPlayer(tracked) {

    if (!tracked.leagueName) {
        return {
            status: "NO_LEAGUE_SET"
        };
    }

    const result =
        await getPlayerFromLeague(
            tracked.leagueName,
            tracked.robloxUserId
        );

    if (!result) {
        return {
            status: "NOT_IN_LEAGUE"
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
            result.leaguePoints -
            previousPoints;
    }

    let rankChange = null;

    if (
        previousRank !== null &&
        previousRank !== undefined
    ) {
        rankChange =
            previousRank -
            result.leagueRank;
    }

    tracked.lastLeague =
        result.leagueName;

    tracked.lastLeaguePoints =
        result.leaguePoints;

    tracked.lastLeagueRank =
        result.leagueRank;

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

        gain,

        rankChange,

        previousPoints,

        previousRank
    };
}

// ============================================================
// COMMANDS
// ============================================================

const commands = [

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
        ),

    new SlashCommandBuilder()
        .setName("setleague")
        .setDescription(
            "Set the League for a tracked player"
        )
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription(
                    "Discord user being tracked"
                )
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("league")
                .setDescription(
                    "Exact PS99 League name"
                )
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("removeuser")
        .setDescription(
            "Remove a tracked Roblox player"
        )
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription(
                    "Discord user to remove"
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
            "Check everyone now"
        ),

    new SlashCommandBuilder()
        .setName("lockin")
        .setDescription(
            "Ping someone 5 times to lock in"
        )
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription(
                    "Person to ping"
                )
                .setRequired(true)
        )

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
            "❌ Command registration error:",
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

        if (!interaction.isChatInputCommand()) {
            return;
        }

        if (!interaction.guildId) {
            return interaction.reply({
                content:
                    "❌ Use this inside a Discord server.",
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
                        "❌ You already have 10 tracked users.",
                    ephemeral: true
                });
            }

            const already =
                guildData.users.some(
                    user =>
                        user.username.toLowerCase() ===
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
                        interaction.user.id,

                    channelId:
                        interaction.channelId,

                    leagueName:
                        null,

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

                return interaction.editReply(
                    `✅ **${roblox.username}** was added!\n\n` +
                    `👤 Discord: <@${interaction.user.id}>\n\n` +
                    `⚠️ Now use:\n` +
                    `\`/setleague user:@${interaction.user.username} league:YOUR_LEAGUE\``
                );

            } catch (error) {

                console.error(error);

                return interaction.editReply(
                    "❌ Something went wrong while finding the Roblox account."
                );
            }
        }

        // ====================================================
        // SET LEAGUE
        // ====================================================

        if (
            interaction.commandName ===
            "setleague"
        ) {

            const discordUser =
                interaction.options.getUser(
                    "user"
                );

            const leagueName =
                interaction.options.getString(
                    "league"
                );

            const tracked =
                guildData.users.find(
                    user =>
                        user.discordUserId ===
                        discordUser.id
                );

            if (!tracked) {

                return interaction.reply({
                    content:
                        `❌ <@${discordUser.id}> doesn't have a tracked Roblox account yet.`,
                    ephemeral: true
                });
            }

            await interaction.deferReply();

            try {

                const league =
                    await getLeague(
                        leagueName
                    );

                if (!league) {

                    return interaction.editReply(
                        `❌ League **${leagueName}** wasn't found.`
                    );
                }

                tracked.leagueName =
                    league.Name;

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
                        `✅ League set for <@${discordUser.id}>\n\n` +

                        `🏆 **League:** ${result.leagueName}\n` +

                        `📊 **League Rank:** #${result.leagueRank}\n` +

                        `⭐ **League Points:** ${result.leaguePoints.toLocaleString()}\n\n` +

                        `⏰ Tracking every **5 minutes**.`
                    );
                }

                return interaction.editReply(
                    `✅ League **${league.Name}** was saved for <@${discordUser.id}>.\n\n` +
                    `⚠️ That player isn't currently in the League's contribution list.`
                );

            } catch (error) {

                console.error(error);

                return interaction.editReply(
                    `❌ Couldn't find League **${leagueName}**.`
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
                `✅ Removed <@${discordUser.id}> from the tracker.`
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

                            const rank =
                                user.lastLeagueRank
                                    ? `#${user.lastLeagueRank}`
                                    : "Unknown";

                            const points =
                                user.lastLeaguePoints !== null
                                    ? user.lastLeaguePoints.toLocaleString()
                                    : "Unknown";

                            return (
                                `**${index + 1}. ${user.username}** — <@${user.discordUserId}>\n` +
                                `🏆 League: **${user.leagueName || "Not set"}**\n` +
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
        // CHECK
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
                        result.status ===
                        "NO_LEAGUE_SET"
                    ) {

                        results.push(
                            `👤 **${user.username}**\n` +
                            `⚠️ League hasn't been set.`
                        );

                        continue;
                    }

                    if (
                        result.status ===
                        "NOT_IN_LEAGUE"
                    ) {

                        results.push(
                            `👤 **${user.username}**\n` +
                            `🏆 League: **${user.leagueName}**\n` +
                            `⚠️ Player isn't currently in the contribution list.`
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
                        `👤 **${user.username}**\n` +
                        `🏆 League: **${result.leagueName}**\n` +
                        `📊 League Rank: **#${result.leagueRank}**\n` +
                        `⭐ League Points: **${result.leaguePoints.toLocaleString()}**\n` +
                        `📈 5m Gain: **${gain}**`
                    );

                } catch (error) {

                    console.error(error);

                    results.push(
                        `❌ **${user.username}** — API error.`
                    );
                }
            }

            return interaction.editReply(
                results.join("\n\n")
            );
        }

        // ====================================================
        // LOCK IN
        // ====================================================

        if (
            interaction.commandName ===
            "lockin"
        ) {

            const user =
                interaction.options.getUser(
                    "user"
                );

            await interaction.reply(
                `🔒 **LOCK IN GET ON** <@${user.id}>`
            );

            for (
                let i = 1;
                i < 5;
                i++
            ) {

                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            500
                        )
                );

                await interaction.followUp(
                    `🔒 **LOCK IN GET ON** <@${user.id}>`
                );
            }

            return;
        }
    }
);

// ============================================================
// 5-MINUTE TRACKER
// ============================================================

async function runTracker() {

    console.log(
        `[${new Date().toLocaleString()}] Checking tracked users...`
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

                if (!tracked.leagueName) {
                    continue;
                }

                const result =
                    await checkPlayer(
                        tracked
                    );

                if (
                    result.status !==
                    "OK"
                ) {

                    console.log(
                        `${tracked.username}: no contribution found`
                    );

                    continue;
                }

                // First successful check = baseline.
                if (
                    result.gain === null
                ) {

                    console.log(
                        `${tracked.username}: baseline established`
                    );

                    continue;
                }

                // =================================================
                // NO GAIN = ONE PING
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

                    await channel.send({
                        content:
                            `<@${tracked.discordUserId}>\n\n` +

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
                        `🚨 Pinged ${tracked.username}`
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
// START
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

client.login(TOKEN);
