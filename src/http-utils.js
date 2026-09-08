import { extname, normalize, resolve, sep } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
}

export function apiError(statusCode, code, message, details) {
  return Object.assign(new Error(message), { statusCode, code, details })
}

export function assert(condition, statusCode, code, message, details) {
  if (!condition) throw apiError(statusCode, code, message, details)
}

export function text(value, max = 500) {
  const output = String(value ?? '').trim()
  if (output.length > max) throw apiError(400, 'ERR_FIELD_TOO_LONG', `字段长度不能超过 ${max} 个字符`)
  return output
}

export function requiredText(value, name, max = 500) {
  const output = text(value, max)
  assert(output, 400, 'ERR_REQUIRED', `${name}不能为空`)
  return output
}

export function integer(value, name, min, max) {
  const output = Number(value)
  assert(Number.isInteger(output) && output >= min && output <= max, 400, 'ERR_NUMBER', `${name}必须是 ${min} 至 ${max} 的整数`)
  return output
}

export function numberValue(value, name, min, max) {
  const output = Number(value)
  assert(Number.isFinite(output) && output >= min && output <= max, 400, 'ERR_NUMBER', `${name}必须在 ${min} 至 ${max} 之间`)
  return output
}

export function boolInt(value) {
  return value === true || value === 1 || value === '1' ? 1 : 0
}

export function parsePage(query) {
  return {
    page: integer(query.page || 1, '页码', 1, 100000),
    pageSize: integer(query.pageSize || 20, '每页数量', 1, 200)
  }
}

export function paged(items, total, page, pageSize) {
  return { items, total: Number(total), page, pageSize, pages: Math.max(1, Math.ceil(Number(total) / pageSize)) }
}

export function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...extraHeaders })
  res.end(body)
}

export function sendFile(res, root, relativePath, cache = false) {
  const safe = normalize(relativePath).replace(/^([/\\])+/, '')
  const file = resolve(root, safe)
  const allowedRoot = resolve(root) + sep
  if (!(file + sep).startsWith(allowedRoot) && file !== resolve(root)) return false
  if (!existsSync(file)) return false
  const body = readFileSync(file)
  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': cache ? 'public, max-age=86400' : 'no-cache'
  })
  res.end(body)
  return true
}

function escapeXml(value) {
  return String(value ?? '').replace(/[<>&"']/g, char => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&apos;' })[char])
}

export function spreadsheetXml(sheetName, columns, rows) {
  const header = columns.map(column => `<Cell ss:StyleID="Header"><Data ss:Type="String">${escapeXml(column.label)}</Data></Cell>`).join('')
  const body = rows.map(row => `<Row>${columns.map(column => {
    const value = typeof column.value === 'function' ? column.value(row) : row[column.value]
    const numeric = typeof value === 'number' && Number.isFinite(value)
    return `<Cell><Data ss:Type="${numeric ? 'Number' : 'String'}">${escapeXml(value)}</Data></Cell>`
  }).join('')}</Row>`).join('')
  return `<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>
  <Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
    <Styles><Style ss:ID="Header"><Font ss:Bold="1"/><Interior ss:Color="#E7EFEA" ss:Pattern="Solid"/></Style></Styles>
    <Worksheet ss:Name="${escapeXml(sheetName)}"><Table><Row>${header}</Row>${body}</Table></Worksheet>
  </Workbook>`
}

export function excelResponse(res, filename, xml) {
  const data = Buffer.from(xml, 'utf8')
  res.writeHead(200, {
    'Content-Type': 'application/vnd.ms-excel; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Content-Length': data.length,
    'Cache-Control': 'no-store'
  })
  res.end(data)
}

export function utcDayStart(now = Date.now()) {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

export function formatDateTime(value) {
  return value ? new Date(Number(value)).toISOString().replace('T', ' ').slice(0, 19) : ''
}
