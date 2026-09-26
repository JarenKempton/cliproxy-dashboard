// Regenerates the PNG app icons in public/ from the ">_" logo. Needs Playwright:
//   npm i --no-save playwright && npx playwright install chromium && node scripts/make-icons.mjs
import { chromium } from 'playwright'
// App icon: the dot-matrix ">_" mark, full-bleed dark square (iOS rounds the corners).
const lit = new Set(['0,0', '1,1', '2,2', '1,3', '0,4', '3,4', '4,4'])
function svg(padding) {
  const step = (100 - 2 * padding) / 5
  let dots = ''
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
    const on = lit.has(`${c},${r}`)
    dots += `<circle cx="${padding + step * (c + 0.5)}" cy="${padding + step * (r + 0.5)}" r="${on ? step * 0.36 : step * 0.18}" fill="${on ? '#1fd5f9' : '#333333'}"/>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#0a0a0a"/>${dots}</svg>`
}
const b = await chromium.launch()
const p = await b.newPage()
// maskable icons keep the mark inside the central safe zone
for (const [name, size, padding] of [['favicon-32.png', 32, 6], ['apple-touch-icon.png', 180, 20], ['icon-192.png', 192, 20], ['icon-512.png', 512, 20], ['icon-maskable-512.png', 512, 26]]) {
  await p.setViewportSize({ width: size, height: size })
  await p.setContent(`<html><body style="margin:0;background:#0a0a0a">${svg(padding).replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`)
  await p.screenshot({ path: new URL(`../public/${name}`, import.meta.url).pathname, omitBackground: false })
}
await b.close(); console.log('icons written')
