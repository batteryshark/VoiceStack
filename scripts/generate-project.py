#!/usr/bin/env python3
"""Generate the two native targets; signing values come only from local build settings.
Set VOICESTACK_BUNDLE_PREFIX to your own reverse-DNS prefix before building for a device."""
from pathlib import Path
import hashlib, os, plistlib
bundle_prefix = os.environ.get('VOICESTACK_BUNDLE_PREFIX', 'com.example.voicestack')
root = Path(__file__).resolve().parents[1]
project = root / 'VoiceStack.xcodeproj'
project.mkdir(exist_ok=True)
objects = {}
def ident(s): return hashlib.sha256(s.encode()).hexdigest()[:24].upper()
def put(name, body):
    key = ident(name); objects[key] = body; return key
def ref(name): return ident(name)
def quoted(s): return '"' + s.replace('"', '\\"') + '"'
shared = sorted((root/'Apps/Shared').glob('*.swift'))
products=[]; targets=[]; fileids=[]
package=put('package', 'isa = XCLocalSwiftPackageReference; relativePath = Packages/VoiceStackCore;')
for platform, folder, sdk, product in [('macOS','VoiceStack-macOS','macosx','VoiceStack Mac'), ('iOS','VoiceStack-iOS','iphoneos','VoiceStack iOS')]:
    sources=shared+sorted((root/'Apps'/folder).glob('*.swift'))
    builds=[]
    for path in sources:
        rel=str(path.relative_to(root)); f=put('file:'+rel, f'isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = {quoted(rel)}; sourceTree = "<group>";')
        if f not in fileids: fileids.append(f)
        builds.append(put(platform+rel, f'isa = PBXBuildFile; fileRef = {f};'))
    productref=put('product'+platform, f'isa = PBXFileReference; explicitFileType = wrapper.application; path = {quoted(product+".app")}; sourceTree = BUILT_PRODUCTS_DIR;')
    products.append(productref)
    dep=put('dep'+platform, f'isa = XCSwiftPackageProductDependency; package = {package}; productName = VoiceStackCore;')
    lib=put('lib'+platform, f'isa = PBXBuildFile; productRef = {dep};')
    sourcephase=put('sources'+platform, 'isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = ('+','.join(builds)+'); runOnlyForDeploymentPostprocessing = 0;')
    frameworkphase=put('frameworks'+platform, f'isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = ({lib}); runOnlyForDeploymentPostprocessing = 0;')
    resources=[]
    for filename, kind in [('AppIcon.icon','folder.icon'),('AppIcon-1024.png','image.png')]:
        rel='Apps/'+folder+'/Icon/'+filename
        f=put('file:'+rel, f'isa = PBXFileReference; lastKnownFileType = {kind}; path = {quoted(rel)}; sourceTree = "<group>";')
        fileids.append(f); resources.append(put(platform+rel,f'isa = PBXBuildFile; fileRef = {f};'))
    resourcephase=put('resources'+platform,'isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = ('+','.join(resources)+'); runOnlyForDeploymentPostprocessing = 0;')
    configs=[]
    for config in ['Debug','Release']:
        values={
          'PRODUCT_NAME':product, 'PRODUCT_BUNDLE_IDENTIFIER':bundle_prefix+'.'+platform.lower(),
          'SDKROOT':sdk, 'SWIFT_VERSION':'5.0', 'SWIFT_STRICT_CONCURRENCY':'targeted', 'CODE_SIGN_STYLE':'Manual',
          'INFOPLIST_FILE':'Apps/'+folder+'/Info.plist', 'GENERATE_INFOPLIST_FILE':'NO',
          'CURRENT_PROJECT_VERSION':'7','MARKETING_VERSION':'0.1.0', 'ENABLE_HARDENED_RUNTIME':'YES',
          'ASSETCATALOG_COMPILER_APPICON_NAME':'AppIcon',
          'SWIFT_OPTIMIZATION_LEVEL':'-Onone' if config=='Debug' else '-O',
          'MACOSX_DEPLOYMENT_TARGET' if platform=='macOS' else 'IPHONEOS_DEPLOYMENT_TARGET':'27.0',
          'SUPPORTED_PLATFORMS':'macosx' if platform=='macOS' else 'iphoneos iphonesimulator',
          'CODE_SIGN_ENTITLEMENTS':'Apps/'+folder+'/VoiceStack.entitlements',
        }
        if platform=='iOS': values['TARGETED_DEVICE_FAMILY']='1,2'
        configs.append(put(platform+config,'isa = XCBuildConfiguration; name = '+config+'; buildSettings = {'+''.join(k+' = '+quoted(v)+';' for k,v in values.items())+'};'))
    configlist=put('configs'+platform, 'isa = XCConfigurationList; buildConfigurations = ('+','.join(configs)+'); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug;')
    target=put('target'+platform,f'isa = PBXNativeTarget; buildConfigurationList = {configlist}; buildPhases = ({sourcephase},{frameworkphase},{resourcephase}); buildRules = (); dependencies = (); name = {quoted(product)}; packageProductDependencies = ({dep}); productName = {quoted(product)}; productReference = {productref}; productType = "com.apple.product-type.application";')
    targets.append(target)
    info={'CFBundleExecutable':'$(EXECUTABLE_NAME)','CFBundleIdentifier':'$(PRODUCT_BUNDLE_IDENTIFIER)','CFBundleName':'VoiceStack','CFBundlePackageType':'APPL','CFBundleShortVersionString':'$(MARKETING_VERSION)','CFBundleVersion':'$(CURRENT_PROJECT_VERSION)','NSMicrophoneUsageDescription':'VoiceStack uses the microphone during a call you explicitly start or answer.','LSMinimumSystemVersion':'27.0'}
    if platform=='iOS': info.update({'UILaunchScreen':{},'UIBackgroundModes':['audio','voip'],'NSFocusStatusUsageDescription':'Your phone’s Focus status controls incoming VoiceStack calls on both devices.','NSUserActivityTypes':['INStartCallIntent'],'VoiceStackAPNSEnvironment':'sandbox'})
    with open(root/'Apps'/folder/'Info.plist','wb') as f: plistlib.dump(info,f)
    ent={'com.apple.security.device.audio-input':True} if platform=='macOS' else {'aps-environment':'development','com.apple.developer.usernotifications.communication':True}
    with open(root/'Apps'/folder/'VoiceStack.entitlements','wb') as f: plistlib.dump(ent,f)
productgroup=put('productgroup', 'isa = PBXGroup; children = ('+','.join(products)+'); name = Products; sourceTree = "<group>";')
main=put('main', 'isa = PBXGroup; children = ('+','.join(fileids+[productgroup])+'); sourceTree = "<group>";')
configs=[put('project'+c,'isa = XCBuildConfiguration; name = '+c+'; buildSettings = {CLANG_ENABLE_MODULES = YES;};') for c in ['Debug','Release']]
configlist=put('projectconfigs','isa = XCConfigurationList; buildConfigurations = ('+','.join(configs)+'); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug;')
proj=put('project',f'isa = PBXProject; attributes = {{LastUpgradeCheck = 2700;}}; buildConfigurationList = {configlist}; compatibilityVersion = "Xcode 15.0"; developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en,Base); mainGroup = {main}; packageReferences = ({package}); productRefGroup = {productgroup}; projectDirPath = ""; projectRoot = ""; targets = ('+','.join(targets)+');')
(project/'project.pbxproj').write_text('// !$*UTF8*$!\n{archiveVersion = 1; classes = {}; objectVersion = 60; objects = {\n'+''.join(k+' = {'+v+'};\n' for k,v in objects.items())+'}; rootObject = '+proj+';}\n')
print('Generated VoiceStack.xcodeproj')
