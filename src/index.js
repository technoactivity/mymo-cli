import * as fs from 'fs'
import path from 'path'
import pify from 'pify'
import simpleGit from 'simple-git/promise'
import rimraf from 'rimraf'
import pLimit from 'p-limit'
import mkdirp from 'mkdirp'
import glob from 'glob'
import {getErrorLogger} from './utils'

// We need to escape \ when used with constructor
// See: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/RegExp
const CommentStartTpl = '(?:\\/\\/\\s|\\/\\*\\s?|<!--\\s?)'
const CommentEndTpl = '.*?\\n'

const getRegEx = entity =>
  ` *?${CommentStartTpl}${entity}_START${CommentEndTpl}((.|\n|\r)*?) *${CommentStartTpl}${entity}_END${CommentEndTpl}`

const REGEX = {
  orm: new RegExp(getRegEx('ORM'), 'g'),
  postgres: new RegExp(getRegEx('POSTGRES'), 'g'),
  mongo: new RegExp(getRegEx('MONGO'), 'g'),
  comment: new RegExp(getRegEx('COMMENT'), 'g'),
  msw: new RegExp(getRegEx('MSW'), 'g'),
}
const ORM_CONTENT = {
  postgres: () => true,
  mongo: () => true,
}
const openFileLimit = pLimit(100)

function mymoCli({
  name,
  fromRepoUrl,
  node,
  orm,
  entityName,
  msw,
  clean,
  ignore = [`${name}/.git/**/*`],
} = {}) {
  const projectDir = `./${name}`
  const projectCloneTmpName = 'clone-tmp'
  const projectCloneTmpDir = `./${projectCloneTmpName}`
  return deletePreviouslyGeneratedFiles()
    .then(cloneRepo)
    .then(updatePackageName)
    .then(getFiles)
    .then(readAllFilesAsPromise)
    .then(createNewContentFiles)
    .then(interpolateName)
    .then(saveFiles)
    .then(deleteCloneTmpRepo)

  function deletePreviouslyGeneratedFiles() {
    if (!clean) {
      return Promise.resolve()
    }
    const pRimraf = pify(rimraf)
    const opts = {disableGlob: true}
    return Promise.all([pRimraf(projectDir, opts)])
  }

  function deleteCloneTmpRepo() {
    const pRimraf = pify(rimraf)
    const opts = {disableGlob: true}
    return Promise.all([pRimraf(projectCloneTmpDir, opts)])
  }

  function cloneRepo() {
    return simpleGit()
      .silent(true)
      .clone(fromRepoUrl, projectCloneTmpName)
  }

  function updatePackageName() {
    if (!node) {
      return Promise.resolve()
    }
    const rawPackageJSON = fs.readFileSync(`${projectCloneTmpDir}/package.json`)
    const parsedPackage = JSON.parse(rawPackageJSON)
    Object.assign(parsedPackage, {name})
    const data = JSON.stringify(parsedPackage, null, 2)
    fs.writeFileSync(`${projectCloneTmpDir}/package.json`, data)
    return Promise.resolve()
  }

  function getFiles() {
    const filesGlob = path.join(projectCloneTmpDir, '**', '*')
    const globOptions = {nodir: true, ignore, dot: true}
    return pify(glob)(filesGlob, globOptions)
  }

  function readFileAsPromise(file) {
    return pify(fs.readFile)(file, 'utf8').then(contents => ({file, contents}))
  }

  function readAllFilesAsPromise(files) {
    const allPromises = files.map(file =>
      openFileLimit(() => readFileAsPromise(file)),
    )
    return Promise.all(allPromises)
  }

  // FIXME: dry
  // eslint-disable-next-line consistent-return
  function createNewContentFiles(fileObjs) {
    return fileObjs.map(fileObj => {
      console.log(fileObj.file.replace(projectCloneTmpName, ''))
      return Object.assign(
        {
          newContent: createContents(fileObj.contents),
        },
        fileObj,
      )
    })
  }

  function createContents(contents) {
    let newContent = contents.replace(REGEX.comment, '')
    if (orm) {
      newContent = newContent.replace(REGEX.orm, '$1')
      if (orm === 'postgres') {
        newContent = newContent
          .replace(REGEX.postgres, '$1')
          .replace(REGEX.mongo, '')
      }
      if (orm === 'mongo') {
        newContent = newContent
          .replace(REGEX.mongo, '$1')
          .replace(REGEX.postgres, '')
      }
    }
    if (msw) {
      newContent = newContent.replace(REGEX.msw, '$1')
    }
    newContent = newContent
      .replace(REGEX.orm, '')
      .replace(REGEX.postgres, '')
      .replace(REGEX.mongo, '')
      .replace(REGEX.msw, '')
    return newContent
  }

  function toPascalCase(str) {
    return str.replace(
      /(\w)(\w*)/g,
      (g0, g1, g2) => g1.toUpperCase() + g2.toLowerCase(),
    )
  }

  function interpolate(contents) {
    return contents
      .replace(/\${projectName}/g, entityName)
      .replace(/\${ProjectName}/g, toPascalCase(entityName))
  }

  function interpolateName(fileObjs) {
    // FIXME: may be a solution with a template directory and tagged templates literals, similar with codege.macro in build time
    return fileObjs.map(fileObj => {
      return Object.assign(fileObj, {
        newContent: interpolate(fileObj.newContent),
        file: fileObj.file.replace(/example/i, entityName)
      })
    })
  }

  function saveFiles(fileObjs) {
    const allPromises = fileObjs.reduce((all, fileObj) => {
      return [...all, ...saveContent(fileObj)]
    }, [])
    return Promise.all(allPromises)
  }

  function saveContent({file, newContent}) {
    const relativeDestination = path.relative(projectCloneTmpDir, file)
    const projectDestination = path.resolve(projectDir, relativeDestination)
    return [
      newContent
        ? openFileLimit(() => saveFile(projectDestination, newContent))
        : null,
    ].filter(Boolean) // filter out the files that weren't saved
  }

  function saveFile(file, contents) {
    return pify(mkdirp)(path.dirname(file), {}).then(() => {
      return pify(fs.writeFile)(file, contents).then(() => file)
    }, getErrorLogger(`mkdirp(${path.dirname(file)})`))
  }
}

export default mymoCli
