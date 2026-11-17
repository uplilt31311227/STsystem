/**
 * 國中調代課自動化系統 - Google Apps Script 後端
 *
 * 部署步驟：
 * 1. 建立新的 Google Sheets 試算表
 * 2. 點選「擴充功能」>「Apps Script」
 * 3. 將此檔案內容貼到 Code.gs
 * 4. 修改下方的 SPREADSHEET_ID 為你的試算表 ID
 * 5. 點選「部署」>「新增部署作業」
 * 6. 選擇「網頁應用程式」
 * 7. 執行身分：「我」
 * 8. 存取權限：「所有人」
 * 9. 部署後複製 Web App URL 到前端系統使用
 */

// ===== 設定區 =====
// 請將下方 ID 替換為你的 Google Sheets 試算表 ID
// 試算表 ID 可從網址取得：https://docs.google.com/spreadsheets/d/[這裡是ID]/edit
const SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID_HERE';
const SHEET_NAME = '調代課紀錄';

// ===== 處理 GET 請求 =====
function doGet(e) {
  // 設定 CORS 標頭
  const output = handleGetRequest(e);
  return output;
}

function handleGetRequest(e) {
  const action = e.parameter.action;

  try {
    if (action === 'test') {
      return jsonResponse({
        success: true,
        message: '連線成功',
        timestamp: new Date().toISOString()
      });
    }

    if (action === 'get') {
      return getRecords(e.parameter);
    }

    if (action === 'getAll') {
      return getAllRecords();
    }

    return jsonResponse({ success: false, error: '未知的操作' });
  } catch (error) {
    return jsonResponse({ success: false, error: error.message });
  }
}

// ===== 處理 POST 請求 =====
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const action = payload.action;

    if (action === 'append') {
      return appendRecord(payload.data);
    }

    if (action === 'delete') {
      return deleteRecord(payload.id);
    }

    if (action === 'update') {
      return updateRecord(payload.id, payload.data);
    }

    if (action === 'batchSync') {
      return batchSync(payload.data);
    }

    return jsonResponse({ success: false, error: '未知的操作' });
  } catch (error) {
    return jsonResponse({ success: false, error: error.message });
  }
}

// ===== 新增紀錄 =====
function appendRecord(data) {
  const sheet = getSheet();
  const headers = getHeaders(sheet);

  // 如果是新表，先建立標題列（包含新欄位）
  if (headers.length === 0) {
    const defaultHeaders = [
      'ID', '異動類型', '日期', '星期', '節次', '班級', '科目', '領域',
      '原任課教師', '代課教師', '假別代碼', '假別名稱', '公假字號',
      '事由', '建立時間'
    ];
    sheet.getRange(1, 1, 1, defaultHeaders.length).setValues([defaultHeaders]);
  }

  // 生成唯一 ID
  const id = data.id || Utilities.getUuid();

  // 新增資料列（包含新欄位）
  const rowData = [
    id,
    data.type || 'substitute',            // 異動類型 (substitute/swap)
    data.date,
    data.weekday,
    data.period,
    data.className,
    data.subject,
    data.domain || '',
    data.originalTeacher,
    data.substituteTeacher,
    data.leaveType || '',                  // 假別代碼
    data.leaveTypeName || '',              // 假別名稱
    data.docNumber || '',                  // 公假字號
    data.reason,
    data.createdAt || new Date().toISOString()
  ];

  sheet.appendRow(rowData);

  return jsonResponse({
    success: true,
    message: '紀錄已新增',
    id: id
  });
}

// ===== 讀取紀錄（含篩選） =====
function getRecords(filters) {
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();

  if (data.length <= 1) {
    return jsonResponse({ success: true, data: [] });
  }

  const headers = data[0];
  const records = [];

  // 建立標題索引
  const headerIndex = {};
  headers.forEach((h, i) => headerIndex[h] = i);

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const record = {};

    headers.forEach((header, index) => {
      record[header] = row[index];
    });

    // 轉換為前端格式（包含新欄位）
    const formattedRecord = {
      id: record['ID'],
      type: record['異動類型'] || 'substitute',
      date: record['日期'],
      weekday: record['星期'],
      period: record['節次'],
      className: record['班級'],
      subject: record['科目'],
      domain: record['領域'],
      originalTeacher: record['原任課教師'],
      substituteTeacher: record['代課教師'],
      leaveType: record['假別代碼'] || '',
      leaveTypeName: record['假別名稱'] || '',
      docNumber: record['公假字號'] || '',
      reason: record['事由'],
      createdAt: record['建立時間']
    };

    // 套用篩選條件
    let include = true;

    if (filters.startDate && formattedRecord.date < filters.startDate) {
      include = false;
    }
    if (filters.endDate && formattedRecord.date > filters.endDate) {
      include = false;
    }
    if (filters.teacher) {
      if (formattedRecord.originalTeacher !== filters.teacher &&
          formattedRecord.substituteTeacher !== filters.teacher) {
        include = false;
      }
    }
    if (filters.className && formattedRecord.className !== filters.className) {
      include = false;
    }

    if (include) {
      records.push(formattedRecord);
    }
  }

  // 按日期排序（新到舊）
  records.sort((a, b) => new Date(b.date) - new Date(a.date));

  return jsonResponse({ success: true, data: records });
}

// ===== 讀取全部紀錄 =====
function getAllRecords() {
  return getRecords({});
}

// ===== 更新紀錄 =====
function updateRecord(id, data) {
  const sheet = getSheet();
  const dataRange = sheet.getDataRange();
  const values = dataRange.getValues();

  const idIndex = 0; // ID 在第一欄

  for (let i = 1; i < values.length; i++) {
    if (values[i][idIndex] === id) {
      // 更新該列資料（包含新欄位）
      const rowData = [
        id,
        data.type || values[i][1],
        data.date || values[i][2],
        data.weekday || values[i][3],
        data.period || values[i][4],
        data.className || values[i][5],
        data.subject || values[i][6],
        data.domain || values[i][7],
        data.originalTeacher || values[i][8],
        data.substituteTeacher || values[i][9],
        data.leaveType || values[i][10],
        data.leaveTypeName || values[i][11],
        data.docNumber || values[i][12],
        data.reason || values[i][13],
        values[i][14] // 保留原建立時間
      ];

      sheet.getRange(i + 1, 1, 1, rowData.length).setValues([rowData]);
      return jsonResponse({ success: true, message: '紀錄已更新' });
    }
  }

  return jsonResponse({ success: false, error: '找不到紀錄' });
}

// ===== 刪除紀錄 =====
function deleteRecord(id) {
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  const idIndex = 0; // ID 在第一欄

  for (let i = 1; i < data.length; i++) {
    if (data[i][idIndex] === id) {
      sheet.deleteRow(i + 1);
      return jsonResponse({ success: true, message: '紀錄已刪除' });
    }
  }

  return jsonResponse({ success: false, error: '找不到紀錄' });
}

// ===== 批次同步 =====
function batchSync(records) {
  const sheet = getSheet();

  // 清除現有資料（保留標題）
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.deleteRows(2, lastRow - 1);
  }

  // 批次新增
  let count = 0;
  records.forEach(record => {
    appendRecord(record);
    count++;
  });

  return jsonResponse({
    success: true,
    message: `已同步 ${count} 筆紀錄`
  });
}

// ===== 輔助函數 =====

/**
 * 取得或建立工作表
 */
function getSheet() {
  let ss;

  try {
    ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  } catch (error) {
    throw new Error('無法開啟試算表，請確認 SPREADSHEET_ID 設定正確');
  }

  let sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    // 建立標題列（包含新欄位）
    const headers = [
      'ID', '異動類型', '日期', '星期', '節次', '班級', '科目', '領域',
      '原任課教師', '代課教師', '假別代碼', '假別名稱', '公假字號',
      '事由', '建立時間'
    ];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

    // 設定標題列格式
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#4285f4');
    headerRange.setFontColor('#ffffff');

    // 凍結標題列
    sheet.setFrozenRows(1);
  }

  return sheet;
}

/**
 * 取得標題列
 */
function getHeaders(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0];
}

/**
 * 回傳 JSON 格式（含 CORS 標頭）
 */
function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== 測試函數 =====

/**
 * 測試新增紀錄（可在 Apps Script 編輯器中執行）
 */
function testAppendRecord() {
  // 測試代課紀錄（公假）
  const testData1 = {
    type: 'substitute',
    date: '2026-03-15',
    weekday: '週一',
    period: '第三節',
    className: '7年1班',
    subject: '數學',
    domain: '數學領域',
    originalTeacher: '方小生',
    substituteTeacher: '李小華',
    leaveType: 'official',
    leaveTypeName: '公假',
    docNumber: '北教字第1140012345號',
    reason: '參加教育局研習'
  };

  const result1 = appendRecord(testData1);
  Logger.log('公假代課: ' + result1.getContent());

  // 測試調課紀錄
  const testData2 = {
    type: 'swap',
    date: '2026-03-16',
    weekday: '週二',
    period: '第一節',
    className: '7年1班',
    subject: '國語文',
    domain: '語文領域',
    originalTeacher: '方小生',
    substituteTeacher: '陳小花',
    leaveType: 'swap',
    leaveTypeName: '調課',
    docNumber: '',
    reason: '調課互換'
  };

  const result2 = appendRecord(testData2);
  Logger.log('調課互換: ' + result2.getContent());
}

/**
 * 測試讀取紀錄
 */
function testGetRecords() {
  const result = getAllRecords();
  Logger.log(result.getContent());
}
