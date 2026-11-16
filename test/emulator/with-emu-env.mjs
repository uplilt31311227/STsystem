#!/usr/bin/env node
/**
 * 以 emulator 預設環境變數包裝執行一支測試：
 *   node test/emulator/with-emu-env.mjs <script> [args...]
 *
 * 未設定時補上 127.0.0.1 預設（Firestore 8080、Auth 9099），已設定則沿用。
 * 只會補本機位址，不會補任何正式環境值；目標腳本自己還會再驗證主機。
 */
import { spawnSync } from 'node:child_process';

const [script, ...args] = process.argv.slice(2);
if (!script) {
    console.error('用法：node test/emulator/with-emu-env.mjs <script> [args...]');
    process.exit(2);
}
const env = {
    ...process.env,
    FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080',
    FIREBASE_AUTH_EMULATOR_HOST: process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099',
};
const r = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit', env });
process.exit(r.status ?? 1);
