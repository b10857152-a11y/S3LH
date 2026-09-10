# 構件數位盤點與儲位管理系統

這是一套供電腦、手機及平板使用的響應式 PWA。第一個可操作版本支援：

- 儲位鎖定。
- 構件與訂單搜尋。
- 多儲位數量盤點。
- 帳面數量差異。
- 圖面確認基準。
- 盤點 Dashboard。
- Excel 預覽與本機匯入。
- 盤點結果匯出。

## GitHub Pages

儲存庫已包含 GitHub Pages 工作流程。GitHub 儲存庫的 Settings → Pages → Source 選擇 GitHub Actions 後，每次更新 `main` 分支都會自動發布。

## 資料模式

目前畫面以本機示範模式運作，資料保存在目前瀏覽器。這適合確認現場流程與介面，但不同裝置不會自動同步。

若要讓電腦與手機共用正式資料，請建立 Supabase 專案並套用 `supabase/schema.sql`。連線完成前，不要把正式盤點資料只保存在瀏覽器中。

## 安全提醒

- GitHub Pages 網站是靜態前端，不要把資料庫密碼或 service role key 放入儲存庫。
- Supabase 前端只使用公開 anon key，且必須啟用 Row Level Security。
- 正式 Excel 檔案與盤點資料不得提交到 GitHub 儲存庫。

