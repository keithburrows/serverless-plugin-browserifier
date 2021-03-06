'use strict'

const Promise = require('bluebird')
const browserify = require('browserify')
const archiver = require('archiver')
const filesize = require('filesize')
const globby = require('globby')
const path = require('path')

const fs = Promise.promisifyAll(require('fs-extra'))

/// //////////////////////// exports && main functions

module.exports = {
  bundle,
  bootstrap
}

function bundle (functionName) {
  const data = this.functionConfigCache[functionName]
  if (!(data)) {
    return Promise.resolve()
  }
  return Promise
    .bind(this)
    .return(data)
    .then(prepareIncludes)
    .then(runBrowserify)
    .then(zip)
    .then(clean)
}

function bootstrap (functionName) {
  if (process.env.SLS_DEBUG) {
    this.serverless.cli.log(`Browserifier: Preparing ${functionName}...`)
  }
  return Promise
    .bind(this)
    .return(functionName)
    .then(prepareInitialData)
    .then(fixServerlessConfig)
}

/// //////////////////////// support functions

function prepareInitialData (functionName) {
  const data = {}
  data.functionName = functionName
  data.outputFolder = path.join(this.servicePath, functionName)
  data.functionBrowserifyConfig = this.getFunctionConfig(functionName)
  data.functionObject = this.serverless.service.getFunction(functionName)
  data.outputBundle = path.relative(this.serverless.config.servicePath, path.join(this.servicePath, `${functionName}.zip`))
  this.functionConfigCache[functionName] = data
  return data
}

function prepareIncludes (data) {
  fs.emptyDirSync(data.outputFolder)
  const includeFiles = globby.sync(data.functionBrowserifyConfig.include, {
    cwd: this.serverless.config.servicePath,
    dot: true,
    silent: true,
    follow: true
  })
  if (process.env.SLS_DEBUG) {
    this.serverless.cli.log('Browserifier: Copying includes: ' + includeFiles)
  }
  includeFiles.forEach(file => {
    fs.copySync(path.join(this.serverless.config.servicePath, file), path.join(data.outputFolder, file))
  })
  return data
}

function runBrowserify (data) {
  
  //If a runtime is declared locally then it cannot (should not) be node so ignore it
  if (data.functionObject.runtime && data.functionObject.runtime.indexOf('nodejs') === -1) {
    if (process.env.SLS_DEBUG) {
      this.serverless.cli.log(`Not browserifying bundle to ${data.outputFolder}`)
    }
    return(data);
  }

  if (process.env.SLS_DEBUG) {
    this.serverless.cli.log(`Browserifier: Writing browserified bundle to ${data.outputFolder}`)
  }
  const cfg = data.functionBrowserifyConfig
  const b = browserify(cfg)
  cfg.exclude.forEach(file => b.exclude(file))
  cfg.ignore.forEach(file => b.ignore(file))
  cfg.external.forEach(file => b.external(file))
  return Promise
    .fromCallback(cb => b.bundle(cb))
    .then(bundleBuffer => {
      const handlerPath = path.join(data.outputFolder, data.functionObject.handler.split('.')[0] + '.js')
      fs.mkdirsSync(path.dirname(handlerPath), '0777') // handler may be in a subdir
      return Promise.fromCallback(cb => fs.writeFile(handlerPath, bundleBuffer, cb))
    })
    .return(data)
}

function zip (data) {

  //If a runtime is declared locally then it cannot (should not) be node so ignore it
  if (data.functionObject.runtime && data.functionObject.runtime.indexOf('nodejs') === -1) {
    if (process.env.SLS_DEBUG) {
      this.serverless.cli.log(`Not zipping browserified bundle to ${data.outputFolder}`);
    }
    return data;
  }

  const outputFile = data.functionObject.artifact || data.functionObject.package.artifact
  if (process.env.SLS_DEBUG) {
    this.serverless.cli.log(`Browserifier: Zipping ${data.outputFolder} to ${outputFile}`)
  }
  const handleStream = (resolve, reject) => {
    const output = fs.createWriteStream(outputFile)
    const archive = archiver.create('zip')

    output.on('close', () => resolve(archive.pointer()))
    archive.on('error', (err) => reject(err))

    archive.pipe(output)
    archive.directory(data.outputFolder, '')
    archive.finalize()
  }
  return new Promise(handleStream).then(sizeInBytes => {
    this.serverless.cli.log(`Browserifier: Created ${data.functionName}.zip (${filesize(sizeInBytes)})...`)
    return data
  })
}

function clean (data) {
  fs.remove(data.outputFolder)
  if (fs.existsSync(data.workaroundFilePath)) {
    fs.remove(data.workaroundFilePath)
  }
  delete this.functionConfigCache[data.functionName]
}

function fixServerlessConfig (data) {
  //If a runtime is declared locally then it cannot (should not) be node so ignore it
  if (data.functionObject.runtime && data.functionObject.runtime.indexOf('nodejs') === -1) {
    if (process.env.SLS_DEBUG) {
      this.serverless.cli.log(`Not fixing Content bundle to ${data.outputFolder}`);
    }
    return data;
  }  
  data.workaroundFilePath = path.relative(this.serverless.config.servicePath, path.join(this.servicePath, 'fool-serverless.txt'))
  return fs.ensureFileAsync(data.workaroundFilePath)
    .then(() => fs.writeFileAsync(data.workaroundFilePath, 'fool packaging step'))
    .then(() => {
      data.functionObject.package = {
        individually: true,
        exclude: [ '**/*' ],
        include: [ data.workaroundFilePath ],
        artifact: data.outputBundle
      }
      return data
    })
}
