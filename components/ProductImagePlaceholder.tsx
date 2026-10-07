import { Feather } from '@expo/vector-icons';
import React from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { useColors } from '@/hooks/useColors';

export function ProductImagePlaceholder({ style, iconSize = 22 }: { style?: StyleProp<ViewStyle>; iconSize?: number }) {
  const colors = useColors();
  return (
    <View style={[styles.placeholder, { backgroundColor: colors.muted }, style]}>
      <Feather name="image" size={iconSize} color={colors.mutedForeground} />
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: { alignItems: 'center', justifyContent: 'center' },
});
