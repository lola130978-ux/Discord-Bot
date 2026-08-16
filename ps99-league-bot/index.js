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
    } catch (error) {
        console.error("❌ Could not read data.json");
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

    if (!Array.isArray(data[guildId].users)) {
        data[guildId].users = [];
    }

    return data[guildId];
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
        // Ignore invalid JSON
    }

    if (!response.ok) {
        const message =
            body?.error?.message ||
            body?.message ||
            `HTTP ${response.status}`;

        throw new Error(message);
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
// GET LEAGUE
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
    const response = await getLeague(leagueName);

    const league = response.data;

    if (!league) {
        return null;
    }

    const contributions =
        Array.isArray(league.PointContributions)
            ? league.PointContributions
            : [];

    const index = contributions.findIndex(
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

        leagueId: league.ID,

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
            status: "PLAYER_NOT_FOUND"
        };
    }

    const previousPoints =
        tracked.lastLeaguePoints;

    const previousTimestamp =
        tracked.lastContributionTimestamp;

    let gain = null;

    if (
        previousPoints !== null &&
        previousPoints !== undefined
    ) {
        gain =
            result.leaguePoints -
            previousPoints;
    }

    let timestampChanged = false;

    if (
        previousTimestamp !== null &&
        previousTimestamp !== undefined &&
        result.timestamp !== null
    ) {
        timestampChanged =
            result.timestamp !==
            previousTimestamp;
    }

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
    // SAVE CURRENT DATA
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

        previousTimestamp
    };
}

// ============================================================
// COMMANDS
// ============================================================

const commands = [

    // ADD USER
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

    // SET LEAGUE
    new SlashCommandBuilder()
        .setName("setleague")
        .setDescription(
            "Set the PS99 League for a tracked user"
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

    // REMOVE USER
    new SlashCommandBuilder()
        .setName("removeuser")
        .setDescription(
            "Remove a tracked user"
        )

        .addUserOption(option =>
            option
                .setName("user")
                .setDescription(
                    "Discord user to remove"
                )
                .setRequired(true)
        ),

    // USERS
    new SlashCommandBuilder()
        .setName("users")
        .setDescription(
            "Show all tracked users"
        ),

    // CHECK
    new SlashCommandBuilder()
        .setName("check")
        .setDescription(
            "Check all tracked users now"
        ),

    // LOCK IN
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
        )

].map(command => command.toJSON());

// ============================================================
// READY
// ============================================================

client.once("ready", async () => {
    console.log(
        `✅ Logged in as ${client.user.tag}`
    );

    const rest = new REST({
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

                return interaction.editReply(
                    `✅ **${roblox.username}** was added!\n\n` +
                    `👤 Ping: <@${discordUser.id}>\n\n` +
                    `Now use:\n` +
                    `\`/setleague user:@${discordUser.username} league:YOUR_LEAGUE\``
                );

            } catch (error) {

                console.error(
                    "Add user error:",
                    error
                );

                return interaction.editReply(
                    "❌ An error occurred while adding the Roblox user."
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
                        `❌ <@${discordUser.id}> isn't being tracked.`,
                    ephemeral: true
                });
            }

            await interaction.deferReply();

            try {

                const response =
                    await getLeague(
                        leagueName
                    );

                if (!response.data) {
                    return interaction.editReply(
                        `❌ League **${leagueName}** wasn't found.`
                    );
                }

                tracked.leagueName =
                    response.data.Name;

                tracked.leagueId =
                    response.data.ID;

                // Reset baseline when League changes
                tracked.lastLeaguePoints =
                    null;

                tracked.lastLeagueRank =
                    null;

                tracked.lastContributionTimestamp =
                    null;

                tracked.unchangedChecks =
                    0;

                saveData();

                const result =
                    await checkPlayer(
                        tracked
                    );

                if (
                    result.status ===
                    "PLAYER_NOT_FOUND"
                ) {

                    return interaction.editReply(
                        `⚠️ League **${response.data.Name}** was set, but **${tracked.username}** wasn't found in that League's contribution list yet.`
                    );
                }

                return interaction.editReply(
                    `✅ League set!\n\n` +
                    `👤 **${tracked.username}**\n` +
                    `🏆 League: **${result.leagueName}**\n` +
                    `📊 League Rank: **#${result.leagueRank}**\n` +
                    `⭐ League Points: **${result.leaguePoints.toLocaleString()}**\n\n` +
                    `⏰ Tracking every **5 minutes**.`
                );

            } catch (error) {

                console.error(
                    "Set league error:",
                    error
                );

                return interaction.editReply(
                    `❌ Couldn't load League **${leagueName}**. Make sure the name is exact.`
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
                        "❌ That user isn't being tracked.",
                    ephemeral: true
                });
            }

            saveData();

            return interaction.reply(
                `✅ Removed <@${discordUser.id}>.`
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
                                user.leagueName ||
                                "Not set";

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
                        "NO_LEAGUE_SET"
                    ) {

                        results.push(
                            `👤 **${tracked.username}**\n` +
                            `🏆 League: **Not set**\n` +
                            `⚠️ Use \`/setleague\` first.`
                        );

                        continue;
                    }

                    if (
                        result.status ===
                        "PLAYER_NOT_FOUND"
                    ) {

                        results.push(
                            `👤 **${tracked.username}**\n` +
                            `🏆 League: **${tracked.leagueName}**\n` +
                            `⚠️ Player wasn't found in the League contribution list.`
                        );

                        continue;
                    }

                    let gainText;

                    if (
                        result.gain === null
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
                        `⏱️ Unchanged Checks: **${result.unchangedChecks}`
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

            await interaction.reply({
                content:
                    "✅ Sending 5 lock-in pings.",
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
        }
    }
);

// ============================================================
// TRACKER
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
            guildData.users.length ===
            0
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

                if (
                    !tracked.leagueName
                ) {

                    console.log(
                        `⚠️ ${tracked.username}: League not set`
                    );

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
                        `⚠️ ${tracked.username}: player not found in League`
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
                // POINTS GAINED
                // =================================================

                if (
                    result.gain > 0
                ) {

                    console.log(
                        `✅ ${tracked.username}: +${result.gain} League Points`
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
                        `🔄 ${tracked.username}: contribution timestamp changed`
                    );

                    continue;
                }

                // =================================================
                // WAIT FOR SECOND CHECK
                // =================================================

                if (
                    result.unchangedChecks < 2
                ) {

                    console.log(
                        `⏳ ${tracked.username}: ` +
                        `${result.unchangedChecks}/2 unchanged checks`
                    );

                    continue;
                }

                // =================================================
                // SEND INACTIVITY PING
                // =================================================

                const channel =
                    guild.channels.cache.get(
                        tracked.channelId
                    );

                if (!channel) {
                    console.log(
                        `❌ Channel not found for ${tracked.username}`
                    );

                    continue;
                }

                await channel.send({

                    content:
                        `🚨 <@${tracked.discordUserId}>\n\n` +

                        `🔒 **LOCK IN GET ON**\n\n` +

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
