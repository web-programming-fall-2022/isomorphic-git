// @ts-check
import '../typedefs.js'

import { MultipleGitError } from '../errors/MultipleGitError'
import { NotFoundError } from '../errors/NotFoundError.js'
import { GitIgnoreManager } from '../managers/GitIgnoreManager.js'
import { GitIndexManager } from '../managers/GitIndexManager.js'
import { FileSystem } from '../models/FileSystem.js'
import { _writeObject } from '../storage/writeObject.js'
import { assertParameter } from '../utils/assertParameter.js'
import { join } from '../utils/join.js'
import { posixifyPathBuffer } from '../utils/posixifyPathBuffer.js'

/**
 * Add a file to the git index (aka staging area)
 *
 * @param {object} args
 * @param {FsClient} args.fs - a file system implementation
 * @param {string} args.dir - The [working tree](dir-vs-gitdir.md) directory path
 * @param {string} [args.gitdir=join(dir, '.git')] - [required] The [git directory](dir-vs-gitdir.md) path
 * @param {string|string[]} args.filepath - The path to the file to add to the index
 * @param {object} [args.cache] - a [cache](cache.md) object
 * @param {boolean} [args.force=false] - add to index even if matches gitignore. Think `git add --force`
 *
 * @returns {Promise<void>} Resolves successfully once the git index has been updated
 *
 * @example
 * await fs.promises.writeFile('/tutorial/README.md', `# TEST`)
 * await git.add({ fs, dir: '/tutorial', filepath: 'README.md' })
 * console.log('done')
 *
 */
export async function add({
  fs: _fs,
  dir,
  gitdir = join(dir, '.git'),
  filepath,
  cache = {},
  force = false,
}) {
  try {
    assertParameter('fs', _fs)
    assertParameter('dir', dir)
    assertParameter('gitdir', gitdir)
    assertParameter('filepath', filepath)

    const fs = new FileSystem(_fs)
    await GitIndexManager.acquire({ fs, gitdir, cache }, async index => {
      return addToIndex({ dir, gitdir, fs, filepath, index, force })
    })
  } catch (err) {
    err.caller = 'git.add'
    throw err
  }
}

async function addToIndex({ dir, gitdir, fs, filepath, index, force }) {
  // TODO: Should ignore UNLESS it's already in the index.
  filepath = Array.isArray(filepath) ? filepath : [filepath]
  filepath = await expandGlobs({ fs, filepath })
  const promises = filepath.map(async currentFilepath => {
    if (!force) {
      const ignored = await GitIgnoreManager.isIgnored({
        fs,
        dir,
        gitdir,
        filepath: currentFilepath,
      })
      if (ignored) return
    }
    const stats = await fs.lstat(join(dir, currentFilepath))
    if (!stats) throw new NotFoundError(currentFilepath)

    if (stats.isDirectory()) {
      const children = await fs.readdir(join(dir, currentFilepath))
      const promises = children.map(child =>
        addToIndex({
          dir,
          gitdir,
          fs,
          filepath: [join(currentFilepath, child)],
          index,
          force,
        })
      )
      await Promise.all(promises)
    } else {
      const object = stats.isSymbolicLink()
        ? await fs.readlink(join(dir, currentFilepath)).then(posixifyPathBuffer)
        : await fs.read(join(dir, currentFilepath))
      if (object === null) throw new NotFoundError(currentFilepath)
      const oid = await _writeObject({ fs, gitdir, type: 'blob', object })
      index.insert({ filepath: currentFilepath, stats, oid })
    }
  })

  const settledPromises = await Promise.allSettled(promises)
  const rejectedPromises = settledPromises
    .filter(settle => settle.status === 'rejected')
    .map(settle => settle.reason)
  if (rejectedPromises.length > 1) {
    throw new MultipleGitError(rejectedPromises)
  }
  if (rejectedPromises.length === 1) {
    throw rejectedPromises[0]
  }

  const fulfilledPromises = settledPromises
    .filter(settle => settle.status === 'fulfilled' && settle.value)
    .map(settle => settle.value)

  return fulfilledPromises
}

async function expandGlobs({ fs, filepath }) {
  return filepath
    .map(async currentFilePath => {
      if (currentFilePath.includes('*')) {
        const glob = currentFilePath
        const globDirectory = glob
          .split('/')
          .slice(0, -1)
          .join('/')
        const globFile = glob
          .split('/')
          .slice(-1)
          .join('/')
        const globRegex = new RegExp(
          '^' + globFile.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
        )
        let globFiles = await fs.readdir(globDirectory)
        globFiles = globFiles.filter(file => globRegex.test(file))
        return globFiles.map(file => join(globDirectory, file))
      }
      return [currentFilePath]
    })
    .reduce((a, b) => a.concat(b), [])
}
