import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { colors, radius, space } from './theme';

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function H1({ children }: { children: ReactNode }) {
  return <Text style={styles.h1}>{children}</Text>;
}

export function H2({ children }: { children: ReactNode }) {
  return <Text style={styles.h2}>{children}</Text>;
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text style={styles.muted}>{children}</Text>;
}

export function Body({ children }: { children: ReactNode }) {
  return <Text style={styles.body}>{children}</Text>;
}

type Variant = 'primary' | 'secondary' | 'danger';

export function Button(props: {
  title: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  busy?: boolean;
  big?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { title, onPress, variant = 'primary', disabled, busy, big, style } = props;
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      onPress={off ? undefined : onPress}
      style={({ pressed }) => [
        styles.btn,
        big && styles.btnBig,
        variant === 'primary' && styles.btnPrimary,
        variant === 'secondary' && styles.btnSecondary,
        variant === 'danger' && styles.btnDanger,
        off && styles.btnOff,
        pressed && !off && styles.btnPressed,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={variant === 'secondary' ? colors.primary : colors.primaryText} />
      ) : (
        <Text
          style={[
            styles.btnText,
            big && styles.btnTextBig,
            variant === 'secondary' ? { color: colors.primary } : { color: colors.primaryText },
          ]}
        >
          {title}
        </Text>
      )}
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label: string; error?: string | null }) {
  const { label, error, style, ...rest } = props;
  return (
    <View style={{ marginBottom: space.md, flex: 1 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.muted}
        style={[styles.input, error ? { borderColor: colors.bad } : null, style]}
        {...rest}
      />
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

export function Banner({ tone, children }: { tone: 'warn' | 'bad' | 'good' | 'info'; children: ReactNode }) {
  const bg = { warn: colors.warnBg, bad: colors.badBg, good: colors.goodBg, info: colors.infoBg }[tone];
  const fg = { warn: colors.warn, bad: colors.bad, good: colors.good, info: colors.primary }[tone];
  return (
    <View style={[styles.banner, { backgroundColor: bg }]}>
      <Text style={{ color: fg, fontSize: 14, lineHeight: 20 }}>{children}</Text>
    </View>
  );
}

export function Stat({ label, value, sub, big }: { label: string; value: string; sub?: string; big?: boolean }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, big && styles.statValueBig]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      {sub ? <Text style={styles.statSub}>{sub}</Text> : null}
    </View>
  );
}

export function Row({ children, gap = space.sm }: { children: ReactNode; gap?: number }) {
  return <View style={{ flexDirection: 'row', gap, alignItems: 'flex-start' }}>{children}</View>;
}

export function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipOn]}
    >
      <Text style={[styles.chipText, selected && { color: colors.primaryText }]}>{label}</Text>
    </Pressable>
  );
}

export const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius,
    padding: space.lg,
    marginBottom: space.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  h1: { fontSize: 24, fontWeight: '700', color: colors.text, marginBottom: space.md },
  h2: { fontSize: 18, fontWeight: '600', color: colors.text, marginBottom: space.sm },
  muted: { fontSize: 14, color: colors.muted, lineHeight: 20 },
  body: { fontSize: 16, color: colors.text, lineHeight: 22 },
  btn: {
    minHeight: 48,
    paddingHorizontal: space.lg,
    borderRadius: radius,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnBig: { minHeight: 64 },
  btnPrimary: { backgroundColor: colors.primary },
  btnSecondary: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.primary },
  btnDanger: { backgroundColor: colors.bad },
  btnOff: { opacity: 0.45 },
  btnPressed: { opacity: 0.8 },
  btnText: { fontSize: 16, fontWeight: '600' },
  btnTextBig: { fontSize: 20 },
  label: { fontSize: 13, color: colors.muted, marginBottom: space.xs, fontWeight: '500' },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.card,
  },
  errorText: { color: colors.bad, fontSize: 13, marginTop: space.xs },
  banner: { borderRadius: 8, padding: space.md, marginBottom: space.md },
  stat: { flex: 1, minWidth: 130, paddingVertical: space.sm },
  statLabel: { fontSize: 13, color: colors.muted, fontWeight: '500' },
  statValue: { fontSize: 28, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] },
  statValueBig: { fontSize: 44 },
  statSub: { fontSize: 13, color: colors.muted },
  chip: {
    paddingHorizontal: space.lg,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  chipOn: { backgroundColor: colors.selected, borderColor: colors.selected },
  chipText: { fontSize: 15, fontWeight: '600', color: colors.text },
});
