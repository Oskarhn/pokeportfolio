import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IdentityAuthority } from '../../src/auth/identity-authority'
import { PhotoStore, toScannerInput, type LocalImageRef } from '../../src/photo/photo-store'
import { FakePhotoPort, deferred, flush } from '../support/fakes'

const image = (uri: string, source: 'camera' | 'library' = 'library'): LocalImageRef => ({
  kind: 'local_image',
  uri,
  width: 640,
  height: 900,
  source,
  acquiredAt: '2026-09-20T12:00:00Z',
})

function make() {
  const port = new FakePhotoPort()
  const authority = new IdentityAuthority()
  authority.observe('A')
  return { port, authority, store: new PhotoStore(port, authority) }
}

describe('PhotoStore (ownership contract; no recognition, no upload)', () => {
  it('acquire -> ready with a typed local image reference', async () => {
    const { port, store } = make()
    port.outcome = { status: 'picked', image: image('file:///cache/1.jpg') }
    await store.acquire('library')
    expect(store.getSnapshot()).toMatchObject({
      status: 'ready',
      image: { uri: 'file:///cache/1.jpg', kind: 'local_image' },
    })
  })

  it('hands a future scanner only a reference: uri and dimensions, never bytes or a URL to upload to', () => {
    expect(toScannerInput(image('file:///cache/1.jpg', 'camera'))).toEqual({
      uri: 'file:///cache/1.jpg',
      width: 640,
      height: 900,
    })
  })

  it('release() deletes the owned file and returns to idle (route exit)', async () => {
    const { port, store } = make()
    port.outcome = { status: 'picked', image: image('file:///cache/1.jpg') }
    await store.acquire('camera')
    await store.release()
    expect(port.deleted).toEqual(['file:///cache/1.jpg'])
    expect(store.getSnapshot()).toMatchObject({ status: 'idle', image: null })
  })

  it('taking another photo releases the previous one first (no accumulation)', async () => {
    const { port, store } = make()
    port.outcome = { status: 'picked', image: image('file:///cache/1.jpg') }
    await store.acquire('library')
    port.outcome = { status: 'picked', image: image('file:///cache/2.jpg') }
    await store.acquire('library')
    expect(port.deleted).toEqual(['file:///cache/1.jpg'])
    expect(store.getSnapshot().image?.uri).toBe('file:///cache/2.jpg')
  })

  it('a denied camera permission is a state with honest copy data, not a crash; canAskAgain is preserved', async () => {
    const { port, store } = make()
    port.outcome = { status: 'permission_denied', canAskAgain: false }
    await store.acquire('camera')
    expect(store.getSnapshot()).toMatchObject({ status: 'denied', canAskAgain: false, image: null })
  })

  it('cancelled and unavailable-camera are distinct states', async () => {
    const { port, store } = make()
    port.outcome = { status: 'cancelled' }
    await store.acquire('library')
    expect(store.getSnapshot().status).toBe('cancelled')
    port.outcome = { status: 'unavailable', reason: 'no_camera' }
    await store.acquire('camera')
    expect(store.getSnapshot()).toMatchObject({
      status: 'unavailable',
      unavailableReason: 'no_camera',
    })
  })

  it('keeps the reason, so a library failure is not reported as a missing camera (P166 emulator)', async () => {
    const { port, store } = make()
    port.outcome = { status: 'unavailable', reason: 'error' }
    await store.acquire('library')
    expect(store.getSnapshot()).toMatchObject({ status: 'unavailable', unavailableReason: 'error' })
  })

  it('a picker that throws is "unavailable", not an unhandled rejection', async () => {
    const { port, store } = make()
    port.acquire = () => Promise.reject(new Error('native module missing'))
    await store.acquire('camera')
    expect(store.getSnapshot().status).toBe('unavailable')
  })

  it('a file that cannot be deleted is RECORDED as leaked (visible, not silent)', async () => {
    const { port, store } = make()
    port.outcome = { status: 'picked', image: image('file:///cache/1.jpg') }
    await store.acquire('library')
    port.deleteError = true
    await store.release()
    expect(store.getSnapshot().leaked).toEqual(['file:///cache/1.jpg'])
  })

  it('an image chosen after the person LEFT the screen (release during acquire) is deleted, not kept', async () => {
    const { port, store } = make()
    port.pending = deferred()
    const p = store.acquire('library')
    await flush()
    await store.release()
    port.pending.resolve({ status: 'picked', image: image('file:///cache/late.jpg') })
    await p
    expect(store.getSnapshot().image).toBeNull()
    expect(port.deleted).toEqual(['file:///cache/late.jpg'])
  })
})

describe('P167: orphaned picker copies (process death) and the identity boundary', () => {
  it('an identity change deletes the shown image AND purges orphaned copies', async () => {
    const { port, store } = make()
    port.outcome = { status: 'picked', image: image('file:///cache/ImagePicker/a.jpg') }
    await store.acquire('library')
    store.reset()
    await flush()
    expect(port.deleted).toEqual(['file:///cache/ImagePicker/a.jpg'])
    expect(port.purges).toBe(1)
    expect(store.getSnapshot().image).toBeNull()
  })

  it('never purges while an image is shown or being acquired (it could be the current photo)', async () => {
    const { port, store } = make()
    port.outcome = { status: 'picked', image: image('file:///cache/ImagePicker/b.jpg') }
    await store.acquire('library')
    await store.purgeOrphans()
    expect(port.purges).toBe(0)
    await store.release()
    port.pending = deferred()
    const p = store.acquire('library')
    await flush()
    await store.purgeOrphans()
    expect(port.purges).toBe(0)
    port.pending.resolve({ status: 'cancelled' })
    await p
    await store.purgeOrphans()
    expect(port.purges).toBe(1)
  })

  it('a purge that fails is recorded as a leak, not swallowed', async () => {
    const { port, store } = make()
    port.purgeError = true
    await store.purgeOrphans()
    expect(store.getSnapshot().leaked).toEqual(['cache:ImagePicker'])
  })

  it('the restart_required reason is kept for the screen', async () => {
    const { port, store } = make()
    port.outcome = { status: 'unavailable', reason: 'restart_required' }
    await store.acquire('library')
    expect(store.getSnapshot()).toMatchObject({
      status: 'unavailable',
      unavailableReason: 'restart_required',
    })
  })
})

describe('photo code stays on the device (static privacy guard)', () => {
  const files = ['src/photo/photo-store.ts', 'src/photo/expo-photo-port.ts']
  it.each(files)('%s imports no network or backend client and makes no request', (file) => {
    const text = readFileSync(join(__dirname, '../..', file), 'utf8')
    expect(text).not.toMatch(
      /from\s+['"](@supabase|@shared\/data|\.\.\/net|\.\.\/seam|\.\.\/auth\/create-client)/,
    )
    expect(text).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|\.upload|uploadAsync|FormData/)
  })

  it('the picker is asked for no location metadata and no in-memory pixel data', () => {
    const text = readFileSync(join(__dirname, '../../src/photo/expo-photo-port.ts'), 'utf8')
    expect(text).toMatch(/exif:\s*false/)
    expect(text).toMatch(/base64:\s*false/)
  })

  it('only files under the app cache are ever deleted (never a user’s original library file)', () => {
    const text = readFileSync(join(__dirname, '../../src/photo/expo-photo-port.ts'), 'utf8')
    expect(text).toMatch(/startsWith\(Paths\.cache\.uri\)/)
  })
})
