import { access, copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

type JsonObject = Record<string, unknown>;

type CliOptions = {
    inputPath: string;
    outputPath: string;
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

type FxBan = FxActionBase & { type: 'ban'; hwids?: string[]; expiration: number | false; };
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
    version: 6;
    players: FxPlayer[];
    actions: FxAction[];
    whitelistApprovals: WhitelistApproval[];
    whitelistRequests: WhitelistRequest[];
    reports: unknown[];
};

type TxRevocation = { timestamp: number | null; author: string | null; };

type TxPlayer = Omit<FxPlayer, never>;

type TxBan = {
    id: string;
    type: 'ban';
    ids: string[];
    hwids?: string[];
    playerName: string | false;
    reason: string;
    author: string;
    timestamp: number;
    expiration: number | false;
    revocation: TxRevocation;
};

type TxWarn = {
    id: string;
    type: 'warn';
    ids: string[];
    playerName: string | false;
    reason: string;
    author: string;
    timestamp: number;
    expiration: false;
    acked: boolean;
    revocation: TxRevocation;
};

type TxDatabase = {
    version: 5;
    players: TxPlayer[];
    actions: Array<TxBan | TxWarn>;
    whitelistApprovals: WhitelistApproval[];
    whitelistRequests: WhitelistRequest[];
};

type MigrationSummary = {
    players: number;
    actions: number;
    bans: number;
    warns: number;
    kicksDropped: number;
    reportsDiscarded: number;
};

const usage = `Usage:
  bun start --input <fxPanel playersDB.json> --output <txAdmin playersDB.json>

Options:
  --help                      Show this help message.

Existing output files are overwritten and backed up as <output>.bak.<timestamp>.
`;

function fail(message: string): never {
    console.error(`Error: ${message}`);
    process.exit(1);
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

const asNullableString = (v: unknown, path: string) =>
    v === null ? null : asString(v, path);

const asNumberOrFalse = (v: unknown, path: string) =>
    v === false ? false : asNumber(v, path);

function optional<T>(v: unknown, path: string, parse: (v: unknown, path: string) => T): T | undefined {
    return typeof v === 'undefined' ? undefined : parse(v, path);
}

function parseNotes(v: unknown, path: string): Notes {
    const o = asRecord(v, path);
    return {
        text: asString(o.text, `${path}.text`),
        lastAdmin: asNullableString(o.lastAdmin, `${path}.lastAdmin`),
        tsLastEdit: o.tsLastEdit === null ? null : asNumber(o.tsLastEdit, `${path}.tsLastEdit`),
    };
}

function parsePlayer(v: unknown, index: number): FxPlayer {
    const path = `players[${index}]`;
    const o = asRecord(v, path);
    const player: FxPlayer = {
        license: asNonEmptyString(o.license, `${path}.license`),
        ids: asStringArray(o.ids, `${path}.ids`),
        hwids: asStringArray(o.hwids, `${path}.hwids`),
        displayName: asString(o.displayName, `${path}.displayName`),
        pureName: asString(o.pureName, `${path}.pureName`),
        playTime: asNumber(o.playTime, `${path}.playTime`),
        tsLastConnection: asNumber(o.tsLastConnection, `${path}.tsLastConnection`),
        tsJoined: asNumber(o.tsJoined, `${path}.tsJoined`),
    };
    const tsWhitelisted = optional(o.tsWhitelisted, `${path}.tsWhitelisted`, asNumber);
    if (tsWhitelisted !== undefined) player.tsWhitelisted = tsWhitelisted;
    const notes = optional(o.notes, `${path}.notes`, parseNotes);
    if (notes) player.notes = notes;
    return player;
}

function parseRevocation(v: unknown, path: string): Revocation {
    const o = asRecord(v, path);
    const r: Revocation = {
        timestamp: asNumber(o.timestamp, `${path}.timestamp`),
        author: asString(o.author, `${path}.author`),
    };
    const reason = optional(o.reason, `${path}.reason`, asString);
    if (reason !== undefined) r.reason = reason;
    return r;
}

function parseAction(v: unknown, index: number): FxAction {
    const path = `actions[${index}]`;
    const o = asRecord(v, path);
    const type = asString(o.type, `${path}.type`);
    const base: FxActionBase = {
        id: asNonEmptyString(o.id, `${path}.id`),
        ids: asStringArray(o.ids, `${path}.ids`),
        playerName: o.playerName === false ? false : asString(o.playerName, `${path}.playerName`),
        reason: asString(o.reason, `${path}.reason`),
        author: asString(o.author, `${path}.author`),
        timestamp: asNumber(o.timestamp, `${path}.timestamp`),
        revocation: optional(o.revocation, `${path}.revocation`, parseRevocation),
    };

    if (type === 'ban') {
        return {
            ...base,
            type,
            hwids: optional(o.hwids, `${path}.hwids`, asStringArray),
            expiration: asNumberOrFalse(o.expiration, `${path}.expiration`),
        };
    }
    if (type === 'warn') {
        return { ...base, type, acked: asBoolean(o.acked, `${path}.acked`) };
    }
    if (type === 'kick') {
        return { ...base, type };
    }
    fail(`${path}.type must be "ban", "warn", or "kick".`);
}

function parseWhitelistApproval(v: unknown, index: number): WhitelistApproval {
    const path = `whitelistApprovals[${index}]`;
    const o = asRecord(v, path);
    return {
        identifier: asNonEmptyString(o.identifier, `${path}.identifier`),
        playerName: asString(o.playerName, `${path}.playerName`),
        playerAvatar: asNullableString(o.playerAvatar, `${path}.playerAvatar`),
        tsApproved: asNumber(o.tsApproved, `${path}.tsApproved`),
        approvedBy: asString(o.approvedBy, `${path}.approvedBy`),
    };
}

function parseWhitelistRequest(v: unknown, index: number): WhitelistRequest {
    const path = `whitelistRequests[${index}]`;
    const o = asRecord(v, path);
    const req: WhitelistRequest = {
        id: asNonEmptyString(o.id, `${path}.id`),
        license: asNonEmptyString(o.license, `${path}.license`),
        playerDisplayName: asString(o.playerDisplayName, `${path}.playerDisplayName`),
        playerPureName: asString(o.playerPureName, `${path}.playerPureName`),
        tsLastAttempt: asNumber(o.tsLastAttempt, `${path}.tsLastAttempt`),
    };
    const discordTag = optional(o.discordTag, `${path}.discordTag`, asString);
    if (discordTag !== undefined) req.discordTag = discordTag;
    const discordAvatar = optional(o.discordAvatar, `${path}.discordAvatar`, asString);
    if (discordAvatar !== undefined) req.discordAvatar = discordAvatar;
    return req;
}

function parseFxDatabase(v: unknown): FxDatabase {
    const root = asRecord(v, 'root');
    const version = asNumber(root.version, 'root.version');
    if (version !== 6) fail(`root.version must be 6, got ${version}.`);

    return {
        version: 6,
        players: asArray(root.players, 'root.players').map(parsePlayer),
        actions: asArray(root.actions, 'root.actions').map(parseAction),
        whitelistApprovals: asArray(root.whitelistApprovals, 'root.whitelistApprovals').map(parseWhitelistApproval),
        whitelistRequests: asArray(root.whitelistRequests, 'root.whitelistRequests').map(parseWhitelistRequest),
        reports: asArray(root.reports, 'root.reports'),
    };
}

const toTxRevocation = (r: Revocation | undefined): TxRevocation =>
    r ? { timestamp: r.timestamp, author: r.author } : { timestamp: null, author: null };

function migrateDatabase(input: FxDatabase): { database: TxDatabase; summary: MigrationSummary; } {
    const summary: MigrationSummary = {
        players: input.players.length,
        actions: 0,
        bans: 0,
        warns: 0,
        kicksDropped: 0,
        reportsDiscarded: input.reports.length,
    };

    const players: TxPlayer[] = input.players.map((p) => {
        const licenseId = `license:${p.license}`;
        const ids = p.ids.includes(licenseId) ? [...p.ids] : [licenseId, ...p.ids];
        const out: TxPlayer = {
            license: p.license,
            ids,
            hwids: [...p.hwids],
            displayName: p.displayName,
            pureName: p.pureName,
            playTime: p.playTime,
            tsLastConnection: p.tsLastConnection,
            tsJoined: p.tsJoined,
        };
        if (p.tsWhitelisted !== undefined) out.tsWhitelisted = p.tsWhitelisted;
        if (p.notes) out.notes = { ...p.notes };
        return out;
    });

    const actions: Array<TxBan | TxWarn> = [];
    for (const a of input.actions) {
        if (a.type === 'ban') {
            actions.push({
                id: a.id,
                type: 'ban',
                ids: [...a.ids],
                hwids: a.hwids ? [...a.hwids] : undefined,
                playerName: a.playerName,
                reason: a.reason,
                author: a.author,
                timestamp: a.timestamp,
                expiration: a.expiration,
                revocation: toTxRevocation(a.revocation),
            });
            summary.bans++;
        } else if (a.type === 'warn') {
            actions.push({
                id: a.id,
                type: 'warn',
                ids: [...a.ids],
                playerName: a.playerName,
                reason: a.reason,
                author: a.author,
                timestamp: a.timestamp,
                expiration: false,
                acked: a.acked,
                revocation: toTxRevocation(a.revocation),
            });
            summary.warns++;
        } else {
            summary.kicksDropped++;
        }
    }

    summary.actions = actions.length;
    return {
        database: {
            version: 5,
            players,
            actions,
            whitelistApprovals: input.whitelistApprovals.map((e) => ({ ...e })),
            whitelistRequests: input.whitelistRequests.map((e) => ({ ...e })),
        },
        summary,
    };
}

function parseArgs(argv: string[]): CliOptions {
    let inputPath: string | undefined;
    let outputPath: string | undefined;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '--help':
            case '-h':
                console.log(usage.trimEnd());
                process.exit(0);
            case '--input':
                inputPath = argv[++i];
                break;
            case '--output':
                outputPath = argv[++i];
                break;
            default:
                fail(`Unknown argument: ${arg}\n\n${usage.trimEnd()}`);
        }
    }

    if (!inputPath) fail(`Missing --input.\n\n${usage.trimEnd()}`);
    if (!outputPath) fail(`Missing --output.\n\n${usage.trimEnd()}`);

    return { inputPath: resolve(inputPath), outputPath: resolve(outputPath) };
}

async function fileExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

async function backupExistingFile(path: string): Promise<string> {
    const timestamp = new Date().toISOString().replaceAll(':', '-');
    const backupPath = `${path}.bak.${timestamp}`;
    await copyFile(path, backupPath);
    return backupPath;
}

async function safeWriteJson(path: string, contents: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tempPath, contents, 'utf8');
    await rename(tempPath, path);
}

async function ensureReadableFile(path: string, label: string): Promise<void> {
    if (!(await fileExists(path))) fail(`${label} file does not exist: ${path}`);
    const info = await stat(path);
    if (!info.isFile()) fail(`${label} path is not a file: ${path}`);
}

function printSummary(summary: MigrationSummary, outputPath: string, backupPath?: string) {
    console.log(`Migrated fxPanel v6 database to txAdmin v5: ${outputPath}`);
    console.log(`Players: ${summary.players}`);
    console.log(`Actions: ${summary.actions} (bans: ${summary.bans}, warns: ${summary.warns})`);
    if (summary.kicksDropped) console.warn(`Dropped unsupported kick actions: ${summary.kicksDropped}`);
    if (summary.reportsDiscarded) console.warn(`Discarded unsupported reports: ${summary.reportsDiscarded}`);
    if (backupPath) console.log(`Backup created: ${backupPath}`);
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    await ensureReadableFile(options.inputPath, 'Input');

    const raw = await readFile(options.inputPath, 'utf8');
    let parsedJson: unknown;
    try {
        parsedJson = JSON.parse(raw);
    } catch (error) {
        fail(`Input file is not valid JSON: ${(error as Error).message}`);
    }

    const { database, summary } = migrateDatabase(parseFxDatabase(parsedJson));
    const serialized = JSON.stringify(database, null, 2) + '\n';

    const backupPath = (await fileExists(options.outputPath))
        ? await backupExistingFile(options.outputPath)
        : undefined;

    await safeWriteJson(options.outputPath, serialized);
    printSummary(summary, options.outputPath, backupPath);
}

await main();
