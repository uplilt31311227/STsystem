#!/usr/bin/env python3
"""
自動化測試腳本
使用 Playwright 執行所有功能測試
"""

import asyncio
from playwright.async_api import async_playwright
import os
import sys

# 修復 Windows 終端編碼問題
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

async def run_tests():
    print("=" * 60)
    print("國中調代課自動化系統 - 自動化測試")
    print("=" * 60)

    async with async_playwright() as p:
        # 啟動瀏覽器
        print("\n[1] 啟動瀏覽器...")
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()

        # 開啟測試頁面
        print("[2] 開啟測試頁面...")
        await page.goto("http://localhost:8080/test/test-runner.html")
        await page.wait_for_load_state("networkidle")

        # 取得頁面標題
        title = await page.title()
        print(f"    頁面標題: {title}")

        # 測試一：課表解析
        print("\n[3] 執行測試一：課表解析...")
        await page.click("button:has-text('執行測試'):nth-of-type(1)")
        await page.wait_for_timeout(2000)

        # 檢查結果
        result1 = await page.query_selector("#parser-result .success")
        if result1:
            text = await result1.inner_text()
            print(f"    ✓ {text}")

            # 取得統計資料
            stats = await page.query_selector_all("#parser-result table:first-of-type tr")
            for stat in stats[1:]:  # 跳過標題列
                stat_text = await stat.inner_text()
                print(f"      {stat_text.replace(chr(9), ': ')}")
        else:
            error = await page.query_selector("#parser-result .error")
            if error:
                print(f"    ✗ {await error.inner_text()}")

        # 測試二：智慧推薦
        print("\n[4] 執行測試二：智慧推薦...")
        buttons = await page.query_selector_all("button:has-text('執行測試')")
        if len(buttons) > 1:
            await buttons[1].click()
        await page.wait_for_timeout(1000)

        result2 = await page.query_selector("#recommendation-result .success")
        if result2:
            print(f"    ✓ {await result2.inner_text()}")

            # 顯示推薦結果
            print("    推薦排序:")
            rows = await page.query_selector_all("#recommendation-result table:last-of-type tr")
            for row in rows[1:6]:  # 前 5 名
                row_text = await row.inner_text()
                cols = row_text.split('\t')
                if len(cols) >= 4:
                    print(f"      {cols[0]}. {cols[1]} ({cols[2]}分) - {cols[3]}")
        else:
            error = await page.query_selector("#recommendation-result .error")
            if error:
                print(f"    ✗ {await error.inner_text()}")

        # 測試三：PDF 生成
        print("\n[5] 執行測試三：PDF 生成...")
        pdf_button = await page.query_selector("button:has-text('生成測試 PDF')")
        if pdf_button:
            # 設定下載路徑
            async with page.expect_download() as download_info:
                await pdf_button.click()
            download = await download_info.value

            # 儲存檔案
            save_path = os.path.join(os.path.dirname(__file__), download.suggested_filename)
            await download.save_as(save_path)
            print(f"    ✓ PDF 已生成: {download.suggested_filename}")
            print(f"    儲存位置: {save_path}")

        # 測試四：月結算
        print("\n[6] 執行測試四：月結算...")
        settle_buttons = await page.query_selector_all("button:has-text('執行測試')")
        if len(settle_buttons) > 2:
            await settle_buttons[2].click()
        await page.wait_for_timeout(1000)

        result4 = await page.query_selector("#settlement-result .success")
        if result4:
            print(f"    ✓ {await result4.inner_text()}")

            # 顯示有調課的教師
            print("    有調課紀錄的教師:")
            rows = await page.query_selector_all("#settlement-result table:last-of-type tr[style*='background']")
            for row in rows:
                row_text = await row.inner_text()
                cols = row_text.split('\t')
                if len(cols) >= 6:
                    print(f"      {cols[0]}: 代課+{cols[3]} 被代{cols[4]} = 實際{cols[5]}節")
        else:
            error = await page.query_selector("#settlement-result .error")
            if error:
                print(f"    ✗ {await error.inner_text()}")

        # 截圖保存
        print("\n[7] 保存測試結果截圖...")
        screenshot_path = os.path.join(os.path.dirname(__file__), "test-result.png")
        await page.screenshot(path=screenshot_path, full_page=True)
        print(f"    截圖已保存: {screenshot_path}")

        # 關閉瀏覽器
        await browser.close()

        print("\n" + "=" * 60)
        print("所有測試完成！")
        print("=" * 60)

if __name__ == "__main__":
    asyncio.run(run_tests())
