/**
 * 把假資料種進 Firebase Emulator
 *
 * 一律以 admin 身分（不帶 idToken）寫入，繞過 Security Rules——種子資料的目的是建立
 * 「已經存在的世界」，不是驗證寫入權限；權限是後續情境測試的事。
 *
 * 可直接執行（node test/emulator/seed.mjs）或由 runner import 後呼叫 seedAll()。
 */

import { pathToFileURL } from 'node:url';

import { ALPHA, BETA, buildSchoolFixture } from '../fixtures/school-fixture.mjs';
import {
    assertEmulator, clearFirestore, clearAuth, createTestUser,
    setDoc, EMULATOR_INFO,
} from './emu-client.mjs';

/** 平台管理者（跨校信任錨點，正式環境只能離線寫入，emulator 直接建立）。 */
const PLATFORM_ADMIN_EMAIL = 'platform.admin@demo.test';
/** 不屬於任何學校的外部人士，用來驗證「非成員什麼都讀不到」。 */
const OUTSIDER_EMAIL = 'outsider@nowhere.test';

async function seedSchool(fixture, log) {
    const { schoolId, config, teachers } = fixture;
    const accounts = new Map();   // teacherId -> { idToken, localId, email }

    // 1) config
    await setDoc(`schools/${schoolId}/config/main`, config);

    // 2) 教師名冊 + emailIndex + Auth 帳號 + userMappings + userDirectory
    for (const t of teachers) {
        const { teacherId, subjectKey, ...doc } = t;
        await setDoc(`schools/${schoolId}/teachers/${teacherId}`, doc);

        if (!t.email) continue;
        await setDoc(`schools/${schoolId}/emailIndex/${t.email}`, { teacherId });

        const user = await createTestUser(t.email);
        accounts.set(teacherId, { ...user, teacherId, name: t.name, role: t.role });

        await setDoc(`schools/${schoolId}/userMappings/${user.localId}`, {
            linkedTeacherId: teacherId,
            email: t.email,
            googleName: t.name,
            lastLoginAt: '2026-08-01T00:00:00.000Z',
        });
        await setDoc(`userDirectory/${user.localId}`, {
            schoolId,
            createdAt: '2026-08-01T00:00:00.000Z',
        });
    }

    // 3) 兩個學期的課表
    for (const [semesterId, sched] of Object.entries(fixture.schedules)) {
        await setDoc(`schools/${schoolId}/schedules/${semesterId}`, {
            scheduleData: sched.parsed,
            teachers: teachers.filter(t => t.subjectKey).map(t => ({
                name: t.name, domains: t.domains, homeroomClass: t.homeroomClass,
            })),
            classes: [...fixture.preset.classes],
            schoolName: config.schoolName,
            subjectDomainMap: {},
            meta: {
                lastAction: 'uploaded',
                byName: teachers.find(t => t.role === 'section_chief').name,
                byTeacherId: teachers.find(t => t.role === 'section_chief').teacherId,
                at: '2026-08-15T00:00:00.000Z',
            },
            updatedAt: '2026-08-15T00:00:00.000Z',
        });
    }

    // 4) 已成立紀錄（目前學期 + 歷史學期）與其私有明細
    const allRecords = [...fixture.substituteRecords, ...fixture.previousSemesterRecords];
    for (const r of allRecords) {
        await setDoc(`schools/${schoolId}/substituteRecords/${r.recordId}`, r.public);
        if (r.private) {
            await setDoc(`schools/${schoolId}/substituteRecords/${r.recordId}/private/detail`, r.private);
        }
    }

    // 5) 待審請求與其私有明細
    for (const req of fixture.pendingRequests) {
        await setDoc(`schools/${schoolId}/pendingRequests/${req.reqId}`, req.public);
        if (req.private) {
            await setDoc(`schools/${schoolId}/pendingRequests/${req.reqId}/private/detail`, req.private);
        }
    }

    // 6) 操作日誌
    for (const l of fixture.operationLogs) {
        await setDoc(`schools/${schoolId}/operationLogs/${l.logId}`, l.data);
    }

    // 7) 公開學校名錄
    await setDoc(`schoolDirectory/${schoolId}`, {
        schoolName: config.schoolName,
        createdAt: config.createdAt,
    });

    log(`  ${schoolId}：教師 ${teachers.length}、帳號 ${accounts.size}、` +
        `課表 ${Object.keys(fixture.schedules).length} 份、紀錄 ${allRecords.length}、` +
        `待審 ${fixture.pendingRequests.length}、日誌 ${fixture.operationLogs.length}`);

    return accounts;
}

/**
 * 清空並重建整個測試世界。
 * @returns 測試需要的所有身分與 fixture
 */
export async function seedAll({ quiet = false } = {}) {
    const log = quiet ? () => {} : (m) => console.log(m);

    await assertEmulator();
    log(`▶ Emulator：Firestore ${EMULATOR_INFO.FIRESTORE_HOST} / Auth ${EMULATOR_INFO.AUTH_HOST} / 專案 ${EMULATOR_INFO.PROJECT_ID}`);

    await clearFirestore();
    await clearAuth();
    log('▶ 已清空 emulator');

    const alpha = buildSchoolFixture(ALPHA);
    const beta  = buildSchoolFixture(BETA);

    const alphaAccounts = await seedSchool(alpha, log);
    const betaAccounts  = await seedSchool(beta, log);

    // 平台管理者：platformAdmins 在正式環境是 client 完全不可寫的信任錨點
    const platformAdmin = await createTestUser(PLATFORM_ADMIN_EMAIL);
    await setDoc(`platformAdmins/${platformAdmin.localId}`, {
        email: PLATFORM_ADMIN_EMAIL,
        createdAt: '2026-08-01T00:00:00.000Z',
        note: '測試用平台管理者',
    });

    // 外部人士：有合法登入帳號，但不屬於任何學校（沒有 userMappings／userDirectory）
    const outsider = await createTestUser(OUTSIDER_EMAIL);

    log(`▶ 平台管理者與外部帳號已建立`);

    const pick = (accounts, fixture, role) => {
        const t = fixture.teachers.find(x => x.role === role && x.email);
        return accounts.get(t.teacherId);
    };
    const plainTeachers = (accounts, fixture) =>
        fixture.teachers.filter(t => t.role === 'teacher' && t.email)
            .map(t => accounts.get(t.teacherId)).filter(Boolean);

    return {
        alpha: {
            fixture: alpha,
            accounts: alphaAccounts,
            director: pick(alphaAccounts, alpha, 'director'),
            sectionChief: pick(alphaAccounts, alpha, 'section_chief'),
            teachers: plainTeachers(alphaAccounts, alpha),
        },
        beta: {
            fixture: beta,
            accounts: betaAccounts,
            director: pick(betaAccounts, beta, 'director'),
            sectionChief: pick(betaAccounts, beta, 'section_chief'),
            teachers: plainTeachers(betaAccounts, beta),
        },
        platformAdmin,
        outsider,
    };
}

// 直接執行時：種完就結束，方便手動用 Emulator UI（http://127.0.0.1:4000）檢視資料。
// 用 pathToFileURL 比對——Windows 的絕對路徑轉成 URL 是 file:///C:/...（三條斜線），
// 手動拼 `file://${argv[1]}` 永遠比不中。
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    seedAll()
        .then(() => {
            console.log('\n✅ 種子資料完成，可在 http://127.0.0.1:4000/firestore 檢視');
            process.exit(0);
        })
        .catch(err => {
            console.error('\n❌ 種子失敗：', err.message);
            process.exit(1);
        });
}
