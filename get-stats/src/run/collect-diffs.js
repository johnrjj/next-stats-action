const path = require('path')
const fs = require('fs-extra')
const exec = require('../util/exec')
const glob = require('../util/glob')
const { prettyPrint } = require('html')
const logger = require('../util/logger')
const { statsAppDir, diffingDir } = require('../constants')

module.exports = async function collectDiffs(
  filesToTrack = [],
  initial = false
) {
  if (initial) {
    logger('Setting up directory for diffing')
    // set-up diffing directory
    await fs.remove(diffingDir)
    await fs.mkdirp(diffingDir)
    await exec(`cd ${diffingDir} && git init`)
  } else {
    // remove any previous files in case they won't be overwritten
    const toRemove = await glob('!(.git)', { cwd: diffingDir, dot: true })

    for (const file of toRemove) {
      await fs.remove(path.join(diffingDir, file))
    }
  }
  const diffs = {}

  for (const fileGroup of filesToTrack) {
    const { globs } = fileGroup
    const curFiles = []

    await Promise.all(
      globs.map(async pattern => {
        curFiles.push(...(await glob(pattern, { cwd: statsAppDir })))
      })
    )

    for (let file of curFiles) {
      const absPath = path.join(statsAppDir, file)

      const diffDest = path.join(diffingDir, file)
      await fs.copy(absPath, diffDest)

      if (file.match(/fetched-pages.*?\.html$/)) {
        // we want to clean up the HTML for diffing
        const srcHTML = await fs.readFile(diffDest, 'utf8')
        await fs.writeFile(diffDest, prettyPrint(srcHTML), 'utf8')
      }
    }
  }

  await exec(`cd ${diffingDir} && git add .`, true)

  if (initial) {
    await exec(
      `cd ${diffingDir} && ` +
        `git config user.name "next stats" && ` +
        `git config user.email "stats@localhost"`
    )
    await exec(`cd ${diffingDir} && git commit -m 'initial commit'`)
  } else {
    let { stdout: renamedFiles } = await exec(
      `cd ${diffingDir} && git diff --name-status HEAD`
    )
    renamedFiles = renamedFiles
      .trim()
      .split('\n')
      .filter(line => line.startsWith('R'))

    for (const line of renamedFiles) {
      const [, prev, cur] = line.split('\t')
      await fs.move(path.join(diffingDir, cur), path.join(diffingDir, prev))
      await exec(`cd ${diffingDir} && git add ${prev}`)
    }

    let { stdout: changedFiles } = await exec(
      `cd ${diffingDir} && git diff --name-only HEAD`
    )
    changedFiles = changedFiles.trim().split('\n')

    for (const file of changedFiles) {
      const fileKey = path.basename(file)
      const hasFile = await fs.exists(path.join(diffingDir, file))

      if (!hasFile) {
        diffs[fileKey] = 'deleted'
        continue
      }
      let { stdout } = await exec(
        `cd ${diffingDir} && git diff --minimal HEAD ${file}`
      )
      stdout = (stdout.split(file).pop() || '').trim()

      if (stdout.length > 0) {
        diffs[fileKey] = stdout
      }
    }
  }
  return diffs
}
