# Playwright 完整網頁截圖工具

這個工具會用真正的 Chromium render 網頁，逐段向下捲動並等待 lazy loading／infinite scroll。只有在抵達頁面底部，而且頁面總高度連續 5 次沒有增加後，才會截取完整頁面。

## 安裝

需要 Node.js 18 或以上版本。

```powershell
npm install
npx playwright install chromium
```

## 執行

```powershell
node screenshot.js "https://example.com"
```

每次執行都會覆寫目前目錄內的 `screenshot.png`。

若網站回傳 HTTP 錯誤、持續無限載入，或截圖失敗，程式會以非零狀態結束並顯示真實錯誤；只要頁面仍可存取，也會嘗試把當下內容保存為 `screenshot.png`。
