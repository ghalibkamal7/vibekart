import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useMemo, useState } from 'react';
import {
  FlatList,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { categories, Category, formatPrice, getProductImages, Product } from '@/data/store';
import { ProductImagePlaceholder } from '@/components/ProductImagePlaceholder';
import { useColors } from '@/hooks/useColors';
import { useStore } from '@/context/StoreContext';

function ProductCard({ product }: { product: Product }) {
  const colors = useColors();
  const { addToCart, isFavorite, toggleFavorite } = useStore();
  const images = getProductImages(product);
  return (
    <Pressable
      onPress={() => router.push(`/product/${product.id}`)}
      style={({ pressed }) => [styles.productCard, { opacity: pressed ? 0.88 : 1 }]}
      testID={`product-${product.id}`}
    >
      <View style={styles.productImageWrap}>
        {images.length ? (
          <Image source={images[0]} style={[styles.productImage, !product.inStock && { opacity: 0.45 }]} />
        ) : (
          <ProductImagePlaceholder style={[styles.productImage, !product.inStock && { opacity: 0.45 }]} />
        )}
        {!product.inStock ? (
          <View style={[styles.newBadge, { backgroundColor: colors.destructive, left: undefined, right: 10 }]}>
            <Text style={styles.newBadgeText}>OUT OF STOCK</Text>
          </View>
        ) : product.isNew ? (
          <View style={[styles.newBadge, { backgroundColor: colors.moss }]}>
            <Text style={styles.newBadgeText}>NEW</Text>
          </View>
        ) : null}
        <Pressable
          onPress={() => toggleFavorite(product.id)}
          style={[styles.favoriteButton, { backgroundColor: colors.card }]}
          hitSlop={10}
          testID={`favorite-${product.id}`}
        >
          <Feather
            name="heart"
            size={17}
            color={isFavorite(product.id) ? colors.coral : colors.mutedForeground}
            fill={isFavorite(product.id) ? colors.coral : 'transparent'}
          />
        </Pressable>
      </View>
      <View style={styles.productInfo}>
        <Text style={[styles.productName, { color: colors.foreground }]} numberOfLines={1}>
          {product.name}
        </Text>
        <Text style={[styles.productSubtitle, { color: colors.mutedForeground }]} numberOfLines={1}>
          {product.subtitle}
        </Text>
        <View style={styles.priceRow}>
          <Text style={[styles.productPrice, { color: colors.foreground }]}>{formatPrice(product.price)}</Text>
          {product.originalPrice ? (
            <Text style={[styles.originalPrice, { color: colors.mutedForeground }]}>
              {formatPrice(product.originalPrice)}
            </Text>
          ) : null}
        </View>
      </View>
      <Pressable
        disabled={!product.inStock}
        onPress={() => addToCart(product, product.sizes?.[0] ?? product.colors[0])}
        style={({ pressed }) => [
          styles.addButton,
          {
            backgroundColor: product.inStock ? colors.coral : colors.muted,
            transform: [{ scale: pressed ? 0.96 : 1 }],
          },
        ]}
        testID={`add-${product.id}`}
      >
        <Feather name="plus" size={18} color={product.inStock ? colors.primaryForeground : colors.mutedForeground} />
      </Pressable>
    </Pressable>
  );
}

export default function HomeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { cartCount, products } = useStore();
  const [category, setCategory] = useState<Category>('All');
  const [query, setQuery] = useState('');
  const filteredProducts = useMemo(
    () =>
      products.filter((product) => {
        const matchesCategory = category === 'All' || product.category === category;
        const matchesQuery =
          !query.trim() ||
          `${product.name} ${product.subtitle}`.toLowerCase().includes(query.toLowerCase());
        return matchesCategory && matchesQuery;
      }),
    [category, query, products],
  );

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <FlatList
        data={filteredProducts}
        numColumns={2}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <ProductCard product={item} />}
        columnWrapperStyle={styles.productRow}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: 120, paddingHorizontal: 18 }}
        ListHeaderComponent={
          <>
            <View style={styles.header}>
              <View>
                <Text style={[styles.eyebrow, { color: colors.coral }]}>GOOD THINGS, CURATED</Text>
                <Text style={[styles.brand, { color: colors.foreground }]}>VibeKart</Text>
              </View>
              <Pressable
                onPress={() => router.push('/cart')}
                style={[styles.cartButton, { backgroundColor: colors.card, borderColor: colors.border }]}
                testID="open-cart"
              >
                <Feather name="shopping-bag" size={20} color={colors.foreground} />
                {cartCount > 0 ? (
                  <View style={[styles.cartCount, { backgroundColor: colors.coral }]}>
                    <Text style={styles.cartCountText}>{cartCount}</Text>
                  </View>
                ) : null}
              </Pressable>
            </View>
            <View style={[styles.hero, { backgroundColor: colors.moss }]}>
              <View style={styles.heroCopy}>
                <Text style={styles.heroKicker}>THE WEEKEND EDIT</Text>
                <Text style={styles.heroTitle}>Find your next{"\n"}little favourite.</Text>
                <Text style={styles.heroBody}>Thoughtful picks. Honest prices. Delivered to your door.</Text>
                <Pressable onPress={() => setCategory('All')} style={styles.heroButton}>
                  <Text style={[styles.heroButtonText, { color: colors.moss }]}>Shop the edit</Text>
                  <Feather name="arrow-up-right" size={16} color={colors.moss} />
                </Pressable>
              </View>
              <View style={[styles.heroOrb, { backgroundColor: colors.butter }]}>
                <Feather name="sun" size={52} color={colors.moss} />
              </View>
            </View>
            <View style={[styles.searchWrap, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Feather name="search" size={19} color={colors.mutedForeground} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search for something lovely"
                placeholderTextColor={colors.mutedForeground}
                style={[styles.searchInput, { color: colors.foreground }]}
                testID="search-input"
              />
              {query ? (
                <Pressable onPress={() => setQuery('')} hitSlop={10}>
                  <Feather name="x-circle" size={18} color={colors.mutedForeground} />
                </Pressable>
              ) : null}
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoryRow}>
              {categories.map((item) => (
                <Pressable
                  key={item.label}
                  onPress={() => setCategory(item.label)}
                  style={[
                    styles.categoryPill,
                    {
                      backgroundColor: category === item.label ? colors.coral : colors.card,
                      borderColor: category === item.label ? colors.coral : colors.border,
                    },
                  ]}
                  testID={`category-${item.label}`}
                >
                  <Feather name={item.icon as keyof typeof Feather.glyphMap} size={15} color={category === item.label ? colors.primaryForeground : colors.moss} />
                  <Text style={[styles.categoryText, { color: category === item.label ? colors.primaryForeground : colors.moss }]}>
                    {item.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <View style={styles.sectionHeader}>
              <View>
                <Text style={[styles.sectionTitle, { color: colors.foreground }]}>
                  {query ? 'Search results' : 'Made for your space'}
                </Text>
                <Text style={[styles.sectionSubtitle, { color: colors.mutedForeground }]}>
                  {filteredProducts.length} things worth bringing home
                </Text>
              </View>
              <Feather name="sliders" size={19} color={colors.moss} />
            </View>
          </>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Feather name="search" size={28} color={colors.mutedForeground} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Nothing matched that.</Text>
            <Text style={[styles.emptyBody, { color: colors.mutedForeground }]}>Try a different word or category.</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 },
  eyebrow: { fontSize: 10, fontFamily: 'Inter_700Bold', letterSpacing: 1.6 },
  brand: { fontSize: 31, fontFamily: 'Inter_700Bold', letterSpacing: -1.5, marginTop: 2 },
  cartButton: { width: 46, height: 46, borderRadius: 17, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  cartCount: { position: 'absolute', right: -3, top: -4, minWidth: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#FFF9F2' },
  cartCountText: { color: '#FFFFFF', fontSize: 10, fontFamily: 'Inter_700Bold' },
  hero: { minHeight: 198, borderRadius: 27, padding: 22, overflow: 'hidden', marginBottom: 18 },
  heroCopy: { width: '72%', zIndex: 1 },
  heroKicker: { color: '#F8CE6A', fontSize: 10, fontFamily: 'Inter_700Bold', letterSpacing: 1.4 },
  heroTitle: { color: '#FFFFFF', fontSize: 27, lineHeight: 31, fontFamily: 'Inter_700Bold', letterSpacing: -1, marginTop: 8 },
  heroBody: { color: '#E4EFE9', fontSize: 12, lineHeight: 18, fontFamily: 'Inter_400Regular', marginTop: 8 },
  heroButton: { backgroundColor: '#FFF9F2', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginTop: 16 },
  heroButtonText: { fontSize: 11, fontFamily: 'Inter_700Bold' },
  heroOrb: { position: 'absolute', width: 132, height: 132, borderRadius: 66, right: -24, bottom: -19, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '-15deg' }] },
  searchWrap: { height: 50, borderRadius: 17, borderWidth: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 15, gap: 10 },
  searchInput: { flex: 1, fontSize: 13, fontFamily: 'Inter_400Regular', paddingVertical: 0 },
  categoryRow: { gap: 8, paddingVertical: 15 },
  categoryPill: { height: 35, borderRadius: 18, borderWidth: 1, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', gap: 6 },
  categoryText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, marginTop: 2 },
  sectionTitle: { fontSize: 20, fontFamily: 'Inter_700Bold', letterSpacing: -0.5 },
  sectionSubtitle: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 3 },
  productRow: { justifyContent: 'space-between', gap: 12 },
  productCard: { width: '48.2%', marginBottom: 18, position: 'relative' },
  productImageWrap: { height: 190, borderRadius: 21, overflow: 'hidden', position: 'relative' },
  productImage: { width: '100%', height: '100%' },
  favoriteButton: { position: 'absolute', top: 10, right: 10, width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  newBadge: { position: 'absolute', left: 10, top: 10, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 8 },
  newBadgeText: { color: '#FFFFFF', fontSize: 9, fontFamily: 'Inter_700Bold', letterSpacing: 0.8 },
  productInfo: { paddingTop: 10, paddingRight: 28 },
  productName: { fontSize: 13, fontFamily: 'Inter_700Bold' },
  productSubtitle: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 3 },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 7 },
  productPrice: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  originalPrice: { textDecorationLine: 'line-through', fontSize: 10, fontFamily: 'Inter_400Regular' },
  addButton: { position: 'absolute', right: 0, bottom: 3, width: 30, height: 30, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  empty: { paddingVertical: 60, alignItems: 'center' },
  emptyTitle: { fontSize: 16, fontFamily: 'Inter_700Bold', marginTop: 14 },
  emptyBody: { fontSize: 13, fontFamily: 'Inter_400Regular', marginTop: 5 },
});