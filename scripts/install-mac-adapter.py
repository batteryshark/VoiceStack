#!/usr/bin/env python3
"""Stage a private local adapter release, then run it under the user's launchd.
The service runs from a copy under ~/Library/Application Support, not from this checkout.
Existing state and voice choices are preserved. No model or speech service is changed.

Expects .private/dev-tailnet.crt, .private/dev-tailnet.key and SWITCHBOARD-BACKEND-KEY.pem
(the output of `switchboard backend key`) in the checkout, and VOICE_BIND in the environment
for the stage action. VOICE_PORT, VOICE_AUDIENCE and VOICESTACK_BUNDLE_PREFIX are optional.
"""
import argparse
import datetime
import os
from pathlib import Path
import plistlib
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('action', choices=['check', 'stage', 'start', 'status', 'stop'])
args = parser.parse_args()
source = Path(__file__).resolve().parent.parent
root = Path.home() / 'Library/Application Support/VoiceStack/ModeAAdapter'
label = os.environ.get('VOICESTACK_BUNDLE_PREFIX', 'com.example.voicestack') + '.adapter'
plist = Path.home() / 'Library/LaunchAgents' / (label + '.plist')
domain = 'gui/' + str(os.getuid())
node = shutil.which('node')
if args.action in ('check', 'stage'):
    required = [source / 'Backend/ModeAAdapter/main.mjs', source / 'node_modules/ws/package.json', source / '.private/dev-tailnet.crt', source / '.private/dev-tailnet.key', source / 'SWITCHBOARD-BACKEND-KEY.pem']
    if not os.environ.get('VOICE_BIND'):
        raise SystemExit('Set VOICE_BIND to the private address the adapter should listen on.')
    if not node or any(not p.is_file() for p in required):
        raise SystemExit('Missing node, adapter dependencies, or provisioned TLS/verification files.')
    subprocess.run([node, '--check', str(required[0])], check=True)
    print('Validated adapter, node, dependencies, TLS and verification file presence.')
if args.action == 'stage':
    root.mkdir(parents=True, exist_ok=True); root.chmod(0o700)
    state = root / 'state'; state.mkdir(exist_ok=True); state.chmod(0o700)
    for name, origin in [('tls.crt', '.private/dev-tailnet.crt'), ('tls.key', '.private/dev-tailnet.key'), ('verify.pem', 'SWITCHBOARD-BACKEND-KEY.pem')]:
        shutil.copyfile(source / origin, state / name); (state / name).chmod(0o600)
    if not (state / 'speech-settings.json').exists() and (source / '.private/speech-settings.json').exists():
        shutil.copyfile(source / '.private/speech-settings.json', state / 'speech-settings.json')
        (state / 'speech-settings.json').chmod(0o600)
    release = root / 'releases' / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    # Copy contents only, not flags or extended attributes.
    for relative in ('Backend/ModeAAdapter', 'node_modules/ws'):
        origin = source / relative
        for entry in origin.rglob('*'):
            if entry.name.startswith('._'): continue
            destination = release / relative / entry.relative_to(origin)
            if entry.is_dir(): destination.mkdir(parents=True, exist_ok=True)
            elif entry.is_file():
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(entry, destination)
    logs = root / 'logs'; logs.mkdir(exist_ok=True)
    config = {
        'Label': label, 'ProgramArguments': [node, str(release / 'Backend/ModeAAdapter/main.mjs')],
        'WorkingDirectory': str(root), 'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 5, 'Umask': 0o077,
        'EnvironmentVariables': {'VOICE_TLS_CERT': str(state / 'tls.crt'), 'VOICE_TLS_KEY': str(state / 'tls.key'), 'VOICE_VERIFY_KEY': str(state / 'verify.pem'), 'VOICE_SETTINGS_FILE': str(state / 'speech-settings.json'), 'VOICE_AUDIENCE': os.environ.get('VOICE_AUDIENCE', 'voicestack-mac-mode-a'), 'VOICE_BIND': os.environ['VOICE_BIND'], 'VOICE_PORT': os.environ.get('VOICE_PORT', '8448')},
        'StandardOutPath': str(logs / 'adapter.log'), 'StandardErrorPath': str(logs / 'adapter-error.log')
    }
    plist.parent.mkdir(parents=True, exist_ok=True)
    temporary = plist.with_suffix('.tmp')
    with temporary.open('wb') as f: plistlib.dump(config, f)
    temporary.chmod(0o600); temporary.replace(plist)
    subprocess.run(['/usr/bin/plutil', '-lint', str(plist)], check=True)
    print('Staged local release:', release)
    print('Service is not started until the start action. Stop any manual listener first.')
elif args.action == 'start':
    subprocess.run(['/bin/launchctl', 'bootout', domain + '/' + label], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['/bin/launchctl', 'bootstrap', domain, str(plist)], check=True)
    print('Started', label)
elif args.action == 'status':
    subprocess.run(['/bin/launchctl', 'print', domain + '/' + label], check=True)
elif args.action == 'stop':
    subprocess.run(['/bin/launchctl', 'bootout', domain + '/' + label], check=True)
