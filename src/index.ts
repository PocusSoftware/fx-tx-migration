import { access, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { readdirSync, statSync } from 'node:fs';

type JsonObject = Record<string, unknown>;

type CliOptions = {
    inputDir: string;
};

type Notes = {
    text: string;
    lastAdmin: string | null;
    tsLastEdit: number | null;
};

type FxPlayer = {
    license: string;
    ids: string[];
    hwids: string[];
    displayName: string;
    pureName: string;
    playTime: number;
    tsLastConnection: number;
    tsJoined: number;
    tsWhitelisted?: number;
    notes?: Notes;
    nameHistory?: string[];
    sessionHistory?: unknown[];
};

type Revocation = { timestamp: number; author: string; reason?: string; };

type FxActionBase = {
    id: string;
    ids: string[];
    playerName: string | false;
    reason: string;
    author: string;
    timestamp: number;
    revocation?: Revocation;
};

type FxBan  = FxActionBase & { type: 'ban';  hwids?: string[]; expiration: number | false; };
type FxWarn = FxActionBase & { type: 'warn'; acked: boolean; };
type FxKick = FxActionBase & { type: 'kick'; };
type FxAction = FxBan | FxWarn | FxKick;

type WhitelistApproval = {
    identifier: string;
    playerName: string;
    playerAvatar: string | null;
    tsApproved: number;
    approvedBy: string;
};

type WhitelistRequest = {
    id: string;
    license: string;
    playerDisplayName: string;
    playerPureName: string;
    discordTag?: string;
    discordAvatar?: string;
    tsLastAttempt: number;
};

type FxDatabase = {
    version: 5 | 6 | 7 | 8 | 9 | 10;
    players: FxPlayer[];
    actions: FxAction[];
    whitelistApprovals: WhitelistApproval[];
    whitelistRequests: WhitelistRequest[];
    reports: unknown[];
};

type TxRevocation = { timestamp: number | null; author: string | null; };
type TxPlayer = Omit<FxPlayer, 'nameHistory' | 'sessionHistory'>;

type TxBan = {
    id: string; type: 'ban'; ids: string[]; hwids?: string[];
    playerName: string | false; reason: string; author: string;
    timestamp: number; expiration: number | false; revocation: TxRevocation;
};

type TxWarn = {
    id: string; type: 'warn'; ids: string[];
    playerName: string | false; reason: string; author: string;
    timestamp: number; expiration: false; acked: boolean; revocation: TxRevocation;
};

type TxDatabase = {
    version: 5;
    players: TxPlayer[];
    actions: Array<TxBan | TxWarn>;
    whitelistApprovals: WhitelistApproval[];
    whitelistRequests: WhitelistRequest[];
};

type MigrationSummary = {
    players: number; actions: number; bans: number; warns: number;
    kicksDropped: number; reportsDiscarded: number;
};

const usage = `Usage:
  bun start --input <fxPanel folder>

Options:
  --help    Show this help message.

The tool will:
  - Search the input folder recursively for playersDB.json, admins.json, config.json
  - Migrate playersDB.json  → <input>/default/data/playersDB.json
  - Migrate config.json     → <input>/config.json
  - Migrate admins.json     → <input>/admins.json (generates random temporary passwords)
  - Delete  addon-data/ folders and addon-config.json, permissionPresets.json files
  - Back up all modified files to ./backup-<timestamp>/ before writing
`;

function fail(message: string): never {
    console.error(`\nError: ${message}`);
    process.exit(1);
}

function parseArgs(argv: string[]): CliOptions {
    let inputDir: string | undefined;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') { console.log(usage.trimEnd()); process.exit(0); }
        else if (arg === '--input') inputDir = argv[++i];
        else fail(`Unknown argument: ${arg}\n\n${usage.trimEnd()}`);
    }

    if (!inputDir) fail(`Missing --input.\n\n${usage.trimEnd()}`);

    return { inputDir: resolve(inputDir) };
}

async function fileExists(path: string): Promise<boolean> {
    try { await access(path); return true; } catch { return false; }
}

async function safeWriteJson(path: string, contents: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, contents, 'utf8');
    await rename(tmp, path);
}

async function backupFile(filePath: string, backupDir: string): Promise<void> {
    if (!(await fileExists(filePath))) return;
    const filename = filePath.split(/[\\/]/).pop()!;
    const dest = join(backupDir, filename);
    await mkdir(backupDir, { recursive: true });
    await copyFile(filePath, dest);
    console.log(`  Backed up: ${filePath} → ${dest}`);
}

function findFiles(dir: string, targets: Set<string>): Map<string, string> {
    const found = new Map<string, string>();

    function walk(current: string) {
        let entries: string[];
        try { entries = readdirSync(current); } catch { return; }

        for (const entry of entries) {
            const full = join(current, entry);
            let info;
            try { info = statSync(full); } catch { continue; }

            if (info.isDirectory()) {
                walk(full);
            } else if (targets.has(entry) && !found.has(entry)) {
                found.set(entry, full);
            }
        }
    }

    walk(dir);
    return found;
}

function findDeletionTargets(dir: string): { dirs: string[]; files: string[]; } {
    const dirs: string[]  = [];
    const files: string[] = [];
    const deleteFiles = new Set(['addon-config.json', 'permissionPresets.json']);
    const deleteDirs  = new Set(['addon-data']);

    function walk(current: string) {
        let entries: string[];
        try { entries = readdirSync(current); } catch { return; }

        for (const entry of entries) {
            const full = join(current, entry);
            let info;
            try { info = statSync(full); } catch { continue; }

            if (info.isDirectory()) {
                if (deleteDirs.has(entry)) {
                    dirs.push(full);
                } else {
                    walk(full);
                }
            } else if (deleteFiles.has(entry)) {
                files.push(full);
            }
        }
    }

    walk(dir);
    return { dirs, files };
}

const isRecord = (v: unknown): v is JsonObject =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

function asRecord(v: unknown, path: string): JsonObject {
    if (!isRecord(v)) fail(`${path} must be an object.`);
    return v;
}
function asString(v: unknown, path: string): string {
    if (typeof v !== 'string') fail(`${path} must be a string.`);
    return v;
}
function asNonEmptyString(v: unknown, path: string): string {
    const s = asString(v, path);
    if (!s.length) fail(`${path} must not be empty.`);
    return s;
}
function asNumber(v: unknown, path: string): number {
    if (typeof v !== 'number' || Number.isNaN(v)) fail(`${path} must be a number.`);
    return v;
}
function asBoolean(v: unknown, path: string): boolean {
    if (typeof v !== 'boolean') fail(`${path} must be a boolean.`);
    return v;
}
function asStringArray(v: unknown, path: string): string[] {
    if (!Array.isArray(v)) fail(`${path} must be an array.`);
    return v.map((e, i) => asString(e, `${path}[${i}]`));
}
function asArray(v: unknown, path: string): unknown[] {
    if (!Array.isArray(v)) fail(`${path} must be an array.`);
    return v;
}
const asNullableString = (v: unknown, path: string) => v === null ? null : asString(v, path);
const asNumberOrFalse  = (v: unknown, path: string) => v === false  ? false : asNumber(v, path);
function optional<T>(v: unknown, path: string, parse: (v: unknown, path: string) => T): T | undefined {
    return typeof v === 'undefined' ? undefined : parse(v, path);
}

function parseNotes(v: unknown, path: string): Notes {
    const o = asRecord(v, path);
    return {
        text:       asString(o.text, `${path}.text`),
        lastAdmin:  asNullableString(o.lastAdmin, `${path}.lastAdmin`),
        tsLastEdit: o.tsLastEdit === null ? null : asNumber(o.tsLastEdit, `${path}.tsLastEdit`),
    };
}

function parsePlayer(v: unknown, index: number): FxPlayer {
    const path = `players[${index}]`;
    const o = asRecord(v, path);
    const player: FxPlayer = {
        license:          asNonEmptyString(o.license, `${path}.license`),
        ids:              asStringArray(o.ids, `${path}.ids`),
        hwids:            asStringArray(o.hwids, `${path}.hwids`),
        displayName:      asString(o.displayName, `${path}.displayName`),
        pureName:         asString(o.pureName, `${path}.pureName`),
        playTime:         asNumber(o.playTime, `${path}.playTime`),
        tsLastConnection: asNumber(o.tsLastConnection, `${path}.tsLastConnection`),
        tsJoined:         asNumber(o.tsJoined, `${path}.tsJoined`),
    };
    const tsWhitelisted = optional(o.tsWhitelisted, `${path}.tsWhitelisted`, asNumber);
    if (tsWhitelisted !== undefined) player.tsWhitelisted = tsWhitelisted;
    const notes = optional(o.notes, `${path}.notes`, parseNotes);
    if (notes) player.notes = notes;
    if (Array.isArray(o.nameHistory))    player.nameHistory    = o.nameHistory as string[];
    if (Array.isArray(o.sessionHistory)) player.sessionHistory = o.sessionHistory;
    return player;
}

function parseRevocation(v: unknown, path: string): Revocation {
    const o = asRecord(v, path);
    const r: Revocation = {
        timestamp: asNumber(o.timestamp, `${path}.timestamp`),
        author:    asString(o.author, `${path}.author`),
    };
    const reason = optional(o.reason, `${path}.reason`, asString);
    if (reason !== undefined) r.reason = reason;
    return r;
}

function parseAction(v: unknown, index: number): FxAction {
    const path = `actions[${index}]`;
    const o    = asRecord(v, path);
    const type = asString(o.type, `${path}.type`);
    const base: FxActionBase = {
        id:         asNonEmptyString(o.id, `${path}.id`),
        ids:        asStringArray(o.ids, `${path}.ids`),
        playerName: o.playerName === false ? false : asString(o.playerName, `${path}.playerName`),
        reason:     asString(o.reason, `${path}.reason`),
        author:     asString(o.author, `${path}.author`),
        timestamp:  asNumber(o.timestamp, `${path}.timestamp`),
        revocation: optional(o.revocation, `${path}.revocation`, parseRevocation),
    };
    if (type === 'ban')  return { ...base, type, hwids: optional(o.hwids, `${path}.hwids`, asStringArray), expiration: asNumberOrFalse(o.expiration, `${path}.expiration`) };
    if (type === 'warn') return { ...base, type, acked: asBoolean(o.acked, `${path}.acked`) };
    if (type === 'kick') return { ...base, type };
    fail(`${path}.type must be "ban", "warn", or "kick".`);
}

function parseWhitelistApproval(v: unknown, index: number): WhitelistApproval {
    const path = `whitelistApprovals[${index}]`;
    const o    = asRecord(v, path);
    return {
        identifier:   asNonEmptyString(o.identifier, `${path}.identifier`),
        playerName:   asString(o.playerName, `${path}.playerName`),
        playerAvatar: asNullableString(o.playerAvatar, `${path}.playerAvatar`),
        tsApproved:   asNumber(o.tsApproved ?? o.tsGranted, `${path}.tsApproved`),
        approvedBy:   asString(o.approvedBy ?? o.grantedBy, `${path}.approvedBy`),
    };
}

function parseWhitelistRequest(v: unknown, index: number): WhitelistRequest {
    const path = `whitelistRequests[${index}]`;
    const o    = asRecord(v, path);
    const req: WhitelistRequest = {
        id:                asNonEmptyString(o.id, `${path}.id`),
        license:           asNonEmptyString(o.license, `${path}.license`),
        playerDisplayName: asString(o.playerDisplayName, `${path}.playerDisplayName`),
        playerPureName:    asString(o.playerPureName, `${path}.playerPureName`),
        tsLastAttempt:     asNumber(o.tsLastAttempt, `${path}.tsLastAttempt`),
    };
    const discordTag    = optional(o.discordTag,    `${path}.discordTag`,    asString);
    const discordAvatar = optional(o.discordAvatar, `${path}.discordAvatar`, asString);
    if (discordTag    !== undefined) req.discordTag    = discordTag;
    if (discordAvatar !== undefined) req.discordAvatar = discordAvatar;
    return req;
}

function parseFxDatabase(v: unknown): FxDatabase {
    const root    = asRecord(v, 'root');
    const version = asNumber(root.version, 'root.version');
    if (version < 5 || version > 10) fail(`Unsupported root.version ${version} — expected 5–10.`);
    return {
        version:            version as 5 | 6 | 7 | 8 | 9 | 10,
        players:            asArray(root.players,            'root.players').map(parsePlayer),
        actions:            asArray(root.actions,            'root.actions').map(parseAction),
        whitelistApprovals: asArray(root.whitelistApprovals ?? root.whitelistEntries ?? [], 'root.whitelistApprovals').map(parseWhitelistApproval),
        whitelistRequests:  asArray(root.whitelistRequests  ?? root.whitelistApplications ?? [], 'root.whitelistRequests').map(parseWhitelistRequest),
        reports:            asArray(root.reports,            'root.reports'),
    };
}

const toTxRevocation = (r: Revocation | undefined): TxRevocation =>
    r ? { timestamp: r.timestamp, author: r.author } : { timestamp: null, author: null };

function migratePlayersDb(input: FxDatabase): { database: TxDatabase; summary: MigrationSummary; } {
    const summary: MigrationSummary = {
        players: input.players.length, actions: 0, bans: 0, warns: 0,
        kicksDropped: 0, reportsDiscarded: input.reports.length,
    };

    const players: TxPlayer[] = input.players.map((p) => {
        // txAdmin looks players up by `license:<hash>` in the ids array, so make sure
        // it is present even if the fxPanel export omitted it (see commit 8e1189d).
        const licenseId = `license:${p.license}`;
        const ids = p.ids.includes(licenseId) ? [...p.ids] : [licenseId, ...p.ids];
        const out: TxPlayer = {
            license: p.license, ids, hwids: [...p.hwids],
            displayName: p.displayName, pureName: p.pureName,
            playTime: p.playTime, tsLastConnection: p.tsLastConnection, tsJoined: p.tsJoined,
        };
        if (p.tsWhitelisted !== undefined) out.tsWhitelisted = p.tsWhitelisted;
        if (p.notes) out.notes = { ...p.notes };
        return out;
    });

    const actions: Array<TxBan | TxWarn> = [];
    for (const a of input.actions) {
        if (a.type === 'ban') {
            actions.push({ id: a.id, type: 'ban', ids: [...a.ids], hwids: a.hwids ? [...a.hwids] : undefined, playerName: a.playerName, reason: a.reason, author: a.author, timestamp: a.timestamp, expiration: a.expiration, revocation: toTxRevocation(a.revocation) });
            summary.bans++;
        } else if (a.type === 'warn') {
            actions.push({ id: a.id, type: 'warn', ids: [...a.ids], playerName: a.playerName, reason: a.reason, author: a.author, timestamp: a.timestamp, expiration: false, acked: a.acked, revocation: toTxRevocation(a.revocation) });
            summary.warns++;
        } else {
            summary.kicksDropped++;
        }
    }

    summary.actions = actions.length;
    return {
        database: { version: 5, players, actions, whitelistApprovals: input.whitelistApprovals.map(e => ({ ...e })), whitelistRequests: input.whitelistRequests.map(e => ({ ...e })) },
        summary,
    };
}

function migrateConfig(raw: JsonObject): JsonObject {
    const out: JsonObject = JSON.parse(JSON.stringify(raw));

    out.version = 2;

    delete out.queue;

    if (isRecord(out.whitelist)) {
        out.whitelist = {};
    }

    if (!isRecord(out.gameFeatures)) out.gameFeatures = {};
    const gf = out.gameFeatures as JsonObject;
    delete gf.reportsEnabled;
    delete gf.ticketFeedbackEnabled;

    return out;
}

const TX_DEFAULT_PERMISSIONS = [
    'players.playermode',
    'players.spectate',
    'players.teleport',
];

function randomPassword(length = 16): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
    let out = '';
    for (let i = 0; i < length; i++) {
        out += chars[Math.floor(Math.random() * chars.length)]!;
    }
    return out;
}

type AdminEntry = {
    name: string;
    plainPassword: string;
    migratedHash: string;
};

async function migrateAdmins(raw: unknown): Promise<{ json: string; log: AdminEntry[]; }> {
    if (!Array.isArray(raw)) fail('admins.json must be an array.');

    const log: AdminEntry[] = [];

    const migrated = await Promise.all(raw.map(async (entry, i) => {
        if (!isRecord(entry)) fail(`admins[${i}] must be an object.`);
        const admin = { ...entry } as JsonObject;

        const plain = randomPassword();
        const hash  = await Bun.password.hash(plain, { algorithm: 'bcrypt', cost: 11 });

        admin.password_hash      = hash;
        admin.password_temporary = true;

        delete admin.password_revision;

        const perms = admin.permissions;
        const hasAllPermissions = Array.isArray(perms) && perms.includes("all_permissions");
        if (!admin.master && !hasAllPermissions) {
            admin.permissions = [...TX_DEFAULT_PERMISSIONS];
        }

        log.push({ name: String(admin.name ?? `admin[${i}]`), plainPassword: plain, migratedHash: hash });

        return admin;
    }));

    return { json: JSON.stringify(migrated, null, 2) + '\n', log };
}

async function readJson(path: string): Promise<unknown> {
    const raw = await readFile(path, 'utf8');
    try { return JSON.parse(raw); } catch (e) { fail(`${path} is not valid JSON: ${(e as Error).message}`); }
}

async function main() {
    const { inputDir } = parseArgs(process.argv.slice(2));
    const outputDir = inputDir;

    if (!(await fileExists(inputDir))) fail(`Input folder does not exist: ${inputDir}`);
    if (!(await stat(inputDir)).isDirectory()) fail(`Input path is not a folder: ${inputDir}`);

    console.log(`\nScanning: ${inputDir}`);

    const found = findFiles(inputDir, new Set(['playersDB.json', 'admins.json', 'config.json']));

    const playersDbPath = found.get('playersDB.json');
    const adminsPath    = found.get('admins.json');
    const configPath    = found.get('config.json');

    if (!playersDbPath) fail('Could not find playersDB.json in the input folder.');
    if (!adminsPath)    fail('Could not find admins.json in the input folder.');
    if (!configPath)    fail('Could not find config.json in the input folder.');

    console.log(`  Found playersDB.json : ${playersDbPath}`);
    console.log(`  Found admins.json    : ${adminsPath}`);
    console.log(`  Found config.json    : ${configPath}`);

    const timestamp = new Date().toISOString().replaceAll(':', '-').replace(/\..+/, '');
    const backupDir = resolve(`backup-${timestamp}`);
    await mkdir(backupDir, { recursive: true });
    console.log(`\nBackup directory: ${backupDir}`);

    const outPlayersDb = join(outputDir, 'default', 'data', 'playersDB.json');
    const outAdmins    = join(outputDir, 'admins.json');
    const outConfig    = join(outputDir, 'config.json');

    await backupFile(outPlayersDb, backupDir);
    await backupFile(outAdmins,    backupDir);
    await backupFile(configPath,   backupDir);

    console.log('\nMigrating playersDB.json...');
    const rawDb  = await readJson(playersDbPath);
    const fxDb   = parseFxDatabase(rawDb);
    const { database, summary } = migratePlayersDb(fxDb);
    await safeWriteJson(outPlayersDb, JSON.stringify(database, null, 2) + '\n');

    console.log(`  Input version : ${fxDb.version}`);
    console.log(`  Players       : ${summary.players}`);
    console.log(`  Bans          : ${summary.bans}`);
    console.log(`  Warns         : ${summary.warns}`);
    if (summary.kicksDropped)     console.warn(`  Kicks dropped : ${summary.kicksDropped}`);
    if (summary.reportsDiscarded) console.warn(`  Reports disc. : ${summary.reportsDiscarded}`);
    console.log(`  Written to    : ${outPlayersDb}`);

    console.log('\nMigrating admins.json...');
    const rawAdmins = await readJson(adminsPath);
    const { json: adminsJson, log: adminsLog } = await migrateAdmins(rawAdmins);
    await safeWriteJson(outAdmins, adminsJson);
    console.log(`  Written to: ${outAdmins}`);
    console.log('\n  Generated passwords (share securely — cannot be recovered):');
    for (const entry of adminsLog) {
        console.log(`    ${entry.name.padEnd(20)} ${entry.plainPassword}`);
    }

    console.log('\nMigrating config.json...');
    const rawConfig     = asRecord(await readJson(configPath), 'config');
    const migratedConfig = migrateConfig(rawConfig);
    await safeWriteJson(outConfig, JSON.stringify(migratedConfig, null, 2) + '\n');
    console.log(`  Written to: ${outConfig}`);

    console.log('\nCleaning up...');
    const { dirs, files } = findDeletionTargets(inputDir);

    for (const dir of dirs) {
        console.log(`  Deleting folder: ${dir}`);
        await rm(dir, { recursive: true, force: true });
    }

    for (const file of files) {
        console.log(`  Deleting file  : ${file}`);
        await rm(file, { force: true });
    }

    if (dirs.length === 0 && files.length === 0) {
        console.log('  Nothing to clean up.');
    }

    console.log('\nDone.\n');
}

await main();
