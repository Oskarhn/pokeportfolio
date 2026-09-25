import { useRef, useState } from 'react'
import { KeyboardAvoidingView, ScrollView, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Body, Button, Heading } from '../components'
import { useRuntime } from '../runtime-context'
import { MIN_TOUCH, SPACE, usePalette } from '../theme'

/** Same on both platforms; exported so a test pins it (an `undefined` here is the P166 F7 defect). */
export const KEYBOARD_BEHAVIOR = 'padding' as const

/**
 * Sign-in against the LOCAL synthetic backend. Credentials live only in component state for the
 * duration of the request; they are never logged, stored or put in a route param. The keyboard
 * handling (KeyboardAvoidingView + a scroll view that keeps taps) is what native forms need.
 */
export function LoginScreen({ notice }: { notice?: string | null }) {
  const runtime = useRuntime()
  const p = usePalette()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const passwordRef = useRef<TextInput>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const input = {
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderColor: p.border,
    borderRadius: 10,
    paddingHorizontal: SPACE.md,
    color: p.text,
    backgroundColor: p.surface,
    fontSize: 16,
  } as const

  async function submit() {
    if (busy) return
    setBusy(true)
    setError(null)
    const result = await runtime.auth.signIn(email.trim(), password)
    if (!result.ok) {
      setError(result.kind === 'invalid_credentials' ? result.message : result.failure.message)
      setBusy(false)
      setPassword('')
    }
    // On success the auth event replaces this screen; nothing to reset.
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: p.background }} testID="login-screen">
      {/* Android 15+ draws edge-to-edge for apps targeting SDK 35+, so `adjustResize` no longer shrinks
          the window for the keyboard: without padding here the keyboard covered "Sign in" (P166 F7). */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={KEYBOARD_BEHAVIOR}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            padding: SPACE.xl,
            gap: SPACE.lg,
            flexGrow: 1,
            justifyContent: 'center',
          }}
        >
          <Heading>Sign in</Heading>
          <Body muted>
            Local spike build. Uses a synthetic account on the isolated local backend.
          </Body>
          {notice ? <Text style={{ color: p.warning }}>{notice}</Text> : null}
          <View style={{ gap: SPACE.sm }}>
            <TextInput
              testID="login-email"
              accessibilityLabel="Email"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              keyboardType="email-address"
              textContentType="username"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => passwordRef.current?.focus()}
              placeholder="Email"
              placeholderTextColor={p.muted}
              style={input}
            />
            <TextInput
              ref={passwordRef}
              testID="login-password"
              accessibilityLabel="Password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="current-password"
              textContentType="password"
              placeholder="Password"
              placeholderTextColor={p.muted}
              returnKeyType="go"
              onSubmitEditing={() => void submit()}
              style={input}
            />
          </View>
          {error !== null ? (
            <Text testID="login-error" accessibilityRole="alert" style={{ color: p.danger }}>
              {error}
            </Text>
          ) : null}
          <Button
            testID="login-submit"
            label={busy ? 'Signing in…' : 'Sign in'}
            onPress={() => void submit()}
            disabled={busy || email.trim() === '' || password === ''}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}
