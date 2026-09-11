import { google } from 'googleapis';
import { log } from '../log.js';

export const MIRROR_NOTE = 'No editar — se actualiza automáticamente cada 15 min desde la base de datos';
export function mirrorRequests(items, tabId) {
  const values = [
    [MIRROR_NOTE],
    ['MLB', 'título', 'stock', 'estado de sync', 'última actualización'],
    ...items.map(item => [item.id, item.title, item.available_quantity, item.sync_status, item.updated_at])
  ];
  const rowCount = Math.max(1000, values.length);
  return [
    { updateSheetProperties: {
      properties: { sheetId: tabId, title: 'Stock (solo lectura)', gridProperties: { rowCount, columnCount: 5, frozenRowCount: 2 } },
      fields: 'title,gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount'
    } },
    { updateCells: {
      range: { sheetId: tabId, startRowIndex: 0, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: 5 },
      rows: values.map((row, index) => ({ values: row.map(value => ({
        userEnteredValue: typeof value === 'number' ? { numberValue: value } : { stringValue: String(value ?? '') },
        ...(index === 0 ? { note: MIRROR_NOTE } : {})
      })) })),
      // Un rango explícito limpia filas antiguas incluso cuando el catálogo achica.
      fields: 'userEnteredValue,note'
    } }
  ];
}
export async function mirrorSync(ctx, sheetsClient) {
  const items = await ctx.repo.allItems();
  const sheets = sheetsClient ?? google.sheets({ version: 'v4', auth: new google.auth.GoogleAuth({
    credentials: ctx.config.googleCredentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  }) });
  await ctx.lease.check();
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: ctx.config.sheetId,
    requestBody: { requests: mirrorRequests(items, ctx.config.tabId) }
  }, { timeout: 60000, retry: false, signal: ctx.lease.signal });
  for (const item of items) ctx.processed.add(item.id);
  log('mirror.updated', { rows: items.length });
}
