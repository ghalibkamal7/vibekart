import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import React from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useStore } from '@/context/StoreContext';

const rows = [
  { icon: 'map-pin', title: 'Saved addresses', detail: 'Add a delivery address' },
  { icon: 'heart', title: 'Saved favourites', detail: 'Your considered picks' },
  { icon: 'help-circle', title: 'Help & support', detail: 'We are here for you' },
];

export default function AccountScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { favorites, authUser, logout, isCloudMode, isAdmin } = useStore();
  const isSeller = !isCloudMode || (authUser && !authUser.isGuest && (authUser.role === 'seller' || authUser.role === 'admin'));
  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.container, { paddingTop: insets.top + 20, paddingBottom: 120 }]}>
      <Text style={[styles.kicker, { color: colors.coral }]}>MAKE IT YOURS</Text>
      <Text style={[styles.title, { color: colors.foreground }]}>Account</Text>
      <View style={[styles.profile, { backgroundColor: colors.moss }]}>
        <Image source={require('@/assets/images/icon.png')} style={styles.avatar} />
        <View style={{ flex: 1 }}>
          <Text style={styles.profileName}>
            {!authUser || authUser.isGuest ? 'Browsing as guest' : authUser.name || authUser.email}
          </Text>
          <Text style={styles.profileDetail}>
            {!authUser || authUser.isGuest ? 'Log in to save your order history' : `${authUser.email} (${authUser.role})`}
          </Text>
        </View>
        <Pressable
          onPress={async () => {
            await logout();
            router.replace('/login');
          }}
          hitSlop={10}
        >
          <Feather name="log-out" size={19} color="#FFFFFF" />
        </Pressable>
      </View>
      {isAdmin ? (
        <Pressable onPress={() => router.push('/admin' as any)} style={[styles.sellerCard, { backgroundColor: '#EEF4FF', borderColor: '#4A6CF7', borderWidth: 1 }]}>
          <View style={[styles.sellerIcon, { backgroundColor: '#4A6CF7' }]}>
            <Feather name="shield" size={20} color="#FFFFFF" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.sellerTitle, { color: colors.foreground }]}>Admin Panel</Text>
            <Text style={[styles.sellerDetail, { color: colors.mutedForeground }]}>Manage products, orders, users, sellers & store settings</Text>
          </View>
          <Feather name="chevron-right" size={19} color="#4A6CF7" />
        </Pressable>
      ) : null}
      {isSeller ? (
        <Pressable onPress={() => router.push('/seller')} style={[styles.sellerCard, { backgroundColor: colors.coralSoft }]}>
          <View style={[styles.sellerIcon, { backgroundColor: colors.coral }]}>
            <Feather name="trending-up" size={20} color={colors.primaryForeground} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.sellerTitle, { color: colors.foreground }]}>Seller space</Text>
            <Text style={[styles.sellerDetail, { color: colors.mutedForeground }]}>See your catalogue, pricing & profit</Text>
          </View>
          <Feather name="chevron-right" size={19} color={colors.coral} />
        </Pressable>
      ) : null}
      <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Your VibeKart</Text>
      {rows.map((row) => (
        <Pressable key={row.title} style={[styles.row, { borderBottomColor: colors.border }]}>
          <View style={[styles.rowIcon, { backgroundColor: colors.mossSoft }]}>
            <Feather name={row.icon as keyof typeof Feather.glyphMap} size={18} color={colors.moss} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.rowTitle, { color: colors.foreground }]}>{row.title}</Text>
            <Text style={[styles.rowDetail, { color: colors.mutedForeground }]}>
              {row.title === 'Saved favourites' ? `${favorites.length} saved picks` : row.detail}
            </Text>
          </View>
          <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
        </Pressable>
      ))}
      <Text style={[styles.version, { color: colors.mutedForeground }]}>VibeKart · Made for good finds</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 18 },
  kicker: { fontSize: 10, fontFamily: 'Inter_700Bold', letterSpacing: 1.7 },
  title: { fontSize: 34, fontFamily: 'Inter_700Bold', letterSpacing: -1.5, marginTop: 8 },
  profile: { flexDirection: 'row', alignItems: 'center', gap: 13, borderRadius: 22, padding: 16, marginTop: 22 },
  avatar: { width: 47, height: 47, borderRadius: 17 },
  profileName: { color: '#FFFFFF', fontSize: 14, fontFamily: 'Inter_700Bold' },
  profileDetail: { color: '#DCEBE5', fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 5 },
  sellerCard: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 20, padding: 14, marginTop: 13 },
  sellerIcon: { width: 41, height: 41, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  sellerTitle: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  sellerDetail: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 3 },
  sectionTitle: { fontSize: 19, fontFamily: 'Inter_700Bold', marginTop: 29, marginBottom: 5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 14, borderBottomWidth: 1 },
  rowIcon: { width: 39, height: 39, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  rowDetail: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 4 },
  version: { textAlign: 'center', fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 34 },
});