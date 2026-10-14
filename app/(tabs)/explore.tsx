import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useMemo } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatPrice, getProductImages, productMatchesCategory } from '@/data/store';
import { ProductImagePlaceholder } from '@/components/ProductImagePlaceholder';
import { useColors } from '@/hooks/useColors';
import { useStore } from '@/context/StoreContext';

export default function ExploreScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { products, categories } = useStore();

  const enabledCategories = useMemo(() => categories.filter((c) => c.enabled), [categories]);

  const trendingProducts = useMemo(() => {
    const active = products.filter((p) => p.enabled !== false);
    const featured = active.filter((p) => p.featured);
    const nonFeatured = active.filter((p) => !p.featured);
    return [...featured, ...nonFeatured].slice(0, 4);
  }, [products]);

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={[styles.container, { paddingTop: insets.top + 20, paddingBottom: 120 }]}
    >
      <Text style={[styles.kicker, { color: colors.coral }]}>A LITTLE INSPO</Text>
      <Text style={[styles.title, { color: colors.foreground }]}>Explore your{"\n"}next mood.</Text>
      <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
        Collections for the way you want today to feel.
      </Text>
      <View style={styles.collectionGrid}>
        {enabledCategories.map((category, index) => {
          const count = products.filter(
            (p) => p.enabled !== false && productMatchesCategory(p.category, category),
          ).length;
          return (
            <Pressable
              key={category.id}
              onPress={() => router.push({ pathname: '/', params: { category: category.id } })}
              style={[styles.collection, { backgroundColor: index % 2 ? colors.mossSoft : colors.coralSoft }]}
            >
              <View>
                <Feather name={(category.icon ?? 'tag') as keyof typeof Feather.glyphMap} size={21} color={index % 2 ? colors.moss : colors.coral} />
                <Text style={[styles.collectionTitle, { color: colors.foreground }]}>{category.name}</Text>
                <Text style={[styles.collectionCount, { color: colors.mutedForeground }]}>
                  {count} curated picks
                </Text>
              </View>
              <Feather name="arrow-up-right" size={18} color={colors.foreground} />
            </Pressable>
          );
        })}
      </View>
      <View style={[styles.callout, { backgroundColor: colors.butter }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.calloutKicker, { color: colors.moss }]}>VIBEKART PROMISE</Text>
          <Text style={[styles.calloutTitle, { color: colors.moss }]}>Good products.{"\n"}Better margins.</Text>
          <Text style={[styles.calloutBody, { color: colors.moss }]}>Every pick is priced clearly so you can shop with confidence.</Text>
        </View>
        <Feather name="smile" size={46} color={colors.moss} />
      </View>
      <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Trending right now</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.horizontalProducts}>
        {trendingProducts.map((product) => {
          const images = getProductImages(product);
          return (
            <Pressable key={product.id} onPress={() => router.push(`/product/${product.id}`)} style={styles.miniProduct}>
              {images.length ? (
                <Image source={images[0]} style={styles.miniImage} />
              ) : (
                <ProductImagePlaceholder style={styles.miniImage} />
              )}
              <Text style={[styles.miniName, { color: colors.foreground }]} numberOfLines={1}>{product.name}</Text>
              <Text style={[styles.miniPrice, { color: colors.coral }]}>{formatPrice(product.price)}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 18 },
  kicker: { fontSize: 10, fontFamily: 'Inter_700Bold', letterSpacing: 1.7 },
  title: { fontSize: 32, lineHeight: 35, fontFamily: 'Inter_700Bold', letterSpacing: -1.5, marginTop: 8 },
  subtitle: { fontSize: 13, lineHeight: 20, fontFamily: 'Inter_400Regular', marginTop: 10, maxWidth: 280 },
  collectionGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 23, gap: 12 },
  collection: { width: '48.1%', minHeight: 150, borderRadius: 22, padding: 16, justifyContent: 'space-between' },
  collectionTitle: { fontSize: 18, fontFamily: 'Inter_700Bold', marginTop: 28 },
  collectionCount: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 4 },
  callout: { borderRadius: 22, padding: 18, flexDirection: 'row', alignItems: 'center', marginTop: 24, minHeight: 144 },
  calloutKicker: { fontSize: 9, letterSpacing: 1.4, fontFamily: 'Inter_700Bold' },
  calloutTitle: { fontSize: 22, lineHeight: 24, fontFamily: 'Inter_700Bold', marginTop: 8 },
  calloutBody: { fontSize: 11, lineHeight: 16, fontFamily: 'Inter_500Medium', marginTop: 7, maxWidth: 220 },
  sectionTitle: { fontSize: 20, fontFamily: 'Inter_700Bold', marginTop: 28 },
  horizontalProducts: { gap: 13, paddingTop: 13, paddingBottom: 10 },
  miniProduct: { width: 130 },
  miniImage: { width: 130, height: 145, borderRadius: 18 },
  miniName: { fontSize: 12, fontFamily: 'Inter_600SemiBold', marginTop: 8 },
  miniPrice: { fontSize: 12, fontFamily: 'Inter_700Bold', marginTop: 4 },
});