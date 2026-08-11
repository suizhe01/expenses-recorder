/**
 * The small set of form pieces the auth screens share. Plain React Native —
 * no design system, because NG-7 keeps styling out of this issue and the
 * screens after this one will decide what the app actually looks like.
 */

import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import type { ReactNode } from 'react';

export function Screen({ children }: { children: ReactNode }) {
  return <View style={styles.screen}>{children}</View>;
}

export function Title({ children }: { children: ReactNode }) {
  return <Text style={styles.title}>{children}</Text>;
}

export function Body({ children }: { children: ReactNode }) {
  return <Text style={styles.body}>{children}</Text>;
}

export function Field({
  label,
  error,
  ...props
}: TextInputProps & { label: string; error?: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={[styles.input, error === undefined ? null : styles.inputError]}
        autoCapitalize="none"
        autoCorrect={false}
        // The label doubles as the accessibility name so tests can find inputs
        // by what the user sees rather than by a testID that drifts from it.
        accessibilityLabel={label}
        {...props}
      />
      {error === undefined ? null : (
        <Text style={styles.fieldError}>{error}</Text>
      )}
    </View>
  );
}

export function FormError({ message }: { message?: string }) {
  if (message === undefined) {
    return null;
  }

  // `accessible` groups the children into one node, which is what makes the
  // alert role reach the accessibility tree — a screen reader announces the
  // message instead of skipping past it, and it becomes queryable by role.
  return (
    <View accessible accessibilityRole="alert" style={styles.formError}>
      <Text style={styles.formErrorText}>{message}</Text>
    </View>
  );
}

export function Notice({ message }: { message?: string }) {
  if (message === undefined) {
    return null;
  }

  return (
    <View accessible accessibilityRole="alert" style={styles.notice}>
      <Text style={styles.noticeText}>{message}</Text>
    </View>
  );
}

export function Button({
  label,
  onPress,
  busy = false,
  variant = 'primary',
}: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  variant?: 'primary' | 'secondary';
}) {
  const isSecondary = variant === 'secondary';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: busy, busy }}
      disabled={busy}
      onPress={onPress}
      style={[
        styles.button,
        isSecondary ? styles.buttonSecondary : null,
        busy ? styles.buttonBusy : null,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={isSecondary ? '#1f6feb' : '#fff'} />
      ) : (
        <Text
          style={[styles.buttonText, isSecondary ? styles.buttonTextSecondary : null]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    gap: 16,
    backgroundColor: '#fff',
  },
  title: { fontSize: 26, fontWeight: '600' },
  body: { fontSize: 15, color: '#444', lineHeight: 22 },
  field: { gap: 6 },
  label: { fontSize: 14, color: '#333' },
  input: {
    borderWidth: 1,
    borderColor: '#c9ccd1',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
  },
  inputError: { borderColor: '#c1341c' },
  fieldError: { color: '#c1341c', fontSize: 13 },
  formError: {
    backgroundColor: '#fdeceb',
    borderRadius: 8,
    padding: 12,
  },
  formErrorText: { color: '#8a2418', fontSize: 14 },
  notice: { backgroundColor: '#eef4fd', borderRadius: 8, padding: 12 },
  noticeText: { color: '#1f4f8f', fontSize: 14 },
  button: {
    backgroundColor: '#1f6feb',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    minHeight: 48,
    justifyContent: 'center',
  },
  buttonSecondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#1f6feb',
  },
  buttonBusy: { opacity: 0.7 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  buttonTextSecondary: { color: '#1f6feb' },
});
