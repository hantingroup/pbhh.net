import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import sharp from 'sharp'

const sizes = [16, 32, 48, 64, 100, 128, 192, 256, 512]
const svgPath = 'public/logo.svg'
const outputDir = 'public/logos'

async function generate() {
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true })
  }

  const svgBuffer = readFileSync(svgPath)

  for (const size of sizes) {
    const png = await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toBuffer()
    await writeFile(`${outputDir}/${size}.png`, png)
    console.log(`Generated ${outputDir}/${size}.png`)
  }
}

generate()
