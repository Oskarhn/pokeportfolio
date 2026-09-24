// Metro resolves the web app's pure modules (src/domain, src/data) from the repository WITHOUT
// moving or copying them. The single seam: those data modules import the web client singleton
// (`./supabase-client`, which reads import.meta.env at import time). Inside src/data only, that one
// specifier is redirected to the native client. Nothing else is aliased.
const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
const repoSrc = path.resolve(projectRoot, '../../src')
const nativeClient = path.resolve(projectRoot, 'src/seam/supabase-client.ts')

const config = getDefaultConfig(projectRoot)
config.watchFolders = [...(config.watchFolders ?? []), repoSrc]
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')]

const upstreamResolve = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // `@shared/domain/money` -> <repo>/src/domain/money (the only path alias; mirrored in tsconfig and Jest).
  if (moduleName.startsWith('@shared/')) {
    return (upstreamResolve ?? context.resolveRequest)(
      context,
      path.join(repoSrc, moduleName.slice('@shared/'.length)),
      platform,
    )
  }
  if (
    moduleName === './supabase-client' &&
    context.originModulePath.startsWith(path.join(repoSrc, 'data'))
  ) {
    return { type: 'sourceFile', filePath: nativeClient }
  }
  return (upstreamResolve ?? context.resolveRequest)(context, moduleName, platform)
}

module.exports = config
