import { Feather } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useState } from 'react';
import { Image, ImageErrorEventData, NativeSyntheticEvent, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatPrice, getCategoryDisplayName, getProductImages } from '@/data/store';
import { ProductImagePlaceholder } from '@/components/ProductImagePlaceholder';
import { useColors } from '@/hooks/useColors';
import { useStore } from '@/context/StoreContext';

export default function ProductDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { products, categories, addToCart, isFavorite, toggleFavorite, authUser, isCloudMode } = useStore();
  const isSeller = !isCloudMode || (authUser && !authUser.isGuest && authUser.role === 'seller');
  const product = products.find((item) => item.id === id);
  const isUnavailable = !product || (product.enabled === false && !isSeller);

  if (isUnavailable || !product) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center', padding: 24 }]}>
        <Feather name="slash" size={48} color={colors.mutedForeground} />
        <Text style={{ fontSize: 20, fontFamily: 'Inter_700Bold', color: colors.foreground, marginTop: 16 }}>
          This pick is no longer available
        </Text>
        <Text style={{ fontSize: 13, fontFamily: 'Inter_400Regular', color: colors.mutedForeground, textAlign: 'center', marginTop: 8, marginBottom: 24 }}>
          This product has been unlisted or is no longer in the catalogue.
        </Text>
        <Pressable
          onPress={() => router.replace('/(tabs)')}
          style={{ backgroundColor: colors.moss, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 14 }}
        >
          <Text style={{ color: '#FFFFFF', fontFamily: 'Inter_700Bold', fontSize: 13 }}>Explore other picks</Text>
        </Pressable>
      </View>
    );
  }

  const [selected, setSelected] = useState(product.sizes?.[1] ?? product.colors[0]);
  const [quantity, setQuantity] = useState(1);
  const images = getProductImages(product);
  const [activeImage, setActiveImage] = useState(0);
  // Track which image indices errored so we can show the placeholder
  const [imageErrors, setImageErrors] = useState<Record<number, boolean>>({});

  const handleImageError = (_e: NativeSyntheticEvent<ImageErrorEventData>, index: number) => {
    setImageErrors((prev) => ({ ...prev, [index]: true }));
  };

  const addQtyToCart = () => {
    for (let i = 0; i < quantity; i++) addToCart(product, selected);
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 120 }}>
        <View style={styles.imageWrap}>
          {images.length && !imageErrors[Math.min(activeImage, images.length - 1)] ? (
            <Image
              source={images[Math.min(activeImage, images.length - 1)]}
              style={styles.image}
              onError={(e) => handleImageError(e, Math.min(activeImage, images.length - 1))}
            />
          ) : (
            <ProductImagePlaceholder style={styles.image} iconSize={40} />
          )}
          <Pressable onPress={() => router.back()} style={[styles.iconButton, { backgroundColor: colors.card, top: insets.top + 10 }]}>
            <Feather name="arrow-left" size={20} color={colors.foreground} />
          </Pressable>
          <Pressable onPress={() => toggleFavorite(product.id)} style={[styles.iconButton, { backgroundColor: colors.card, top: insets.top + 10, right: 18 }]}>
            <Feather name="heart" size={19} color={isFavorite(product.id) ? colors.coral : colors.foreground} fill={isFavorite(product.id) ? colors.coral : 'transparent'} />
          </Pressable>
          {!product.inStock ? (
            <View style={[styles.stockBadge, { backgroundColor: colors.destructive }]}>
              <Text style={styles.stockBadgeText}>OUT OF STOCK</Text>
            </View>
          ) : null}
        </View>
        {images.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbRow}>
            {images.map((source, index) => (
              <Pressable
                key={index}
                onPress={() => setActiveImage(index)}
                style={[
                  styles.thumb,
                  { borderColor: index === activeImage ? colors.moss : colors.border, borderWidth: index === activeImage ? 2 : 1 },
                ]}
              >
                {imageErrors[index] ? (
                  <ProductImagePlaceholder style={styles.thumbImage} />
                ) : (
                  <Image
                    source={source}
                    style={styles.thumbImage}
                    onError={(e) => handleImageError(e, index)}
                  />
                )}
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
        <View style={styles.content}>
          <View style={styles.detailTop}>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={[styles.category, { color: colors.coral }]}>{getCategoryDisplayName(product.category, categories).toUpperCase()}</Text>
                {product.isNew ? (
                  <View style={{ backgroundColor: colors.moss, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 }}>
                    <Text style={{ color: '#FFFFFF', fontSize: 8, fontFamily: 'Inter_700Bold' }}>NEW</Text>
                  </View>
                ) : null}
                {product.featured ? (
                  <View style={{ backgroundColor: colors.coralSoft, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 }}>
                    <Text style={{ color: colors.coral, fontSize: 8, fontFamily: 'Inter_700Bold' }}>FEATURED</Text>
                  </View>
                ) : null}
                {product.enabled === false ? (
                  <View style={{ backgroundColor: colors.destructive, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 }}>
                    <Text style={{ color: '#FFFFFF', fontSize: 8, fontFamily: 'Inter_700Bold' }}>UNLISTED</Text>
                  </View>
                ) : null}
              </View>
              <Text style={[styles.title, { color: colors.foreground }]}>{product.name}</Text>
              <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>{product.subtitle}</Text>
            </View>
            <View style={styles.rating}>
              <Feather name="star" size={14} color={colors.butter} fill={colors.butter} />
              <Text style={[styles.ratingText, { color: colors.foreground }]}>{product.rating}</Text>
            </View>
          </View>
          <View style={styles.priceRow}>
            <Text style={[styles.price, { color: colors.foreground }]}>{formatPrice(product.price)}</Text>
            {product.originalPrice ? <Text style={[styles.originalPrice, { color: colors.mutedForeground }]}>{formatPrice(product.originalPrice)}</Text> : null}
            <View style={[styles.reviews, { backgroundColor: colors.mossSoft }]}>
              <Text style={[styles.reviewsText, { color: colors.moss }]}>{product.reviews} reviews</Text>
            </View>
          </View>
          <Text style={[styles.description, { color: colors.inkSoft }]}>{product.description}</Text>
          <Text style={[styles.optionLabel, { color: colors.foreground }]}>{product.sizes ? 'Choose your size' : 'Choose a finish'}</Text>
          <View style={styles.options}>
            {(product.sizes ?? product.colors).map((option) => (
              <Pressable key={option} onPress={() => setSelected(option)} style={[styles.option, { backgroundColor: selected === option ? colors.moss : colors.card, borderColor: selected === option ? colors.moss : colors.border }]}>
                <Text style={[styles.optionText, { color: selected === option ? '#FFFFFF' : colors.foreground }]}>{option}</Text>
              </Pressable>
            ))}
          </View>
          {/* Quantity selector */}
          {product.inStock ? (
            <View style={styles.qtyRow}>
              <Text style={[styles.optionLabel, { color: colors.foreground, marginTop: 0 }]}>Quantity</Text>
              <View style={styles.qtyControls}>
                <Pressable
                  onPress={() => setQuantity((q) => Math.max(1, q - 1))}
                  style={[styles.qtyBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
                  hitSlop={8}
                >
                  <Feather name="minus" size={15} color={colors.foreground} />
                </Pressable>
                <Text style={[styles.qtyValue, { color: colors.foreground }]}>{quantity}</Text>
                <Pressable
                  onPress={() => setQuantity((q) => Math.min(99, q + 1))}
                  style={[styles.qtyBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
                  hitSlop={8}
                >
                  <Feather name="plus" size={15} color={colors.foreground} />
                </Pressable>
              </View>
            </View>
          ) : null}
          <View style={[styles.delivery, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="truck" size={18} color={colors.moss} />
            <View>
              <Text style={[styles.deliveryTitle, { color: colors.foreground }]}>Free delivery on this pick</Text>
              <Text style={[styles.deliveryBody, { color: colors.mutedForeground }]}>Arrives in 4–6 working days</Text>
            </View>
          </View>
        </View>
      </ScrollView>
      <View style={[styles.bottomBar, { backgroundColor: colors.background, borderTopColor: colors.border, paddingBottom: Math.max(insets.bottom, 14) }]}>
        <Pressable
          disabled={!product.inStock}
          onPress={addQtyToCart}
          style={({ pressed }) => [
            styles.addToCart,
            { backgroundColor: product.inStock ? colors.coral : colors.muted, opacity: pressed ? 0.86 : 1 },
          ]}
          testID="add-to-cart"
        >
          <Feather name="shopping-bag" size={18} color={product.inStock ? '#FFFFFF' : colors.mutedForeground} />
          <Text style={[styles.addToCartText, !product.inStock && { color: colors.mutedForeground }]}>
            {product.inStock ? `Add ${quantity > 1 ? `${quantity} × ` : ''}to cart` : 'Out of stock'}
          </Text>
          {product.inStock ? <Text style={styles.addToCartPrice}>{formatPrice(product.price * quantity)}</Text> : null}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  imageWrap: { height: 390, position: 'relative' },
  image: { width: '100%', height: '100%' },
  stockBadge: { position: 'absolute', bottom: 14, left: 18, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  stockBadgeText: { color: '#FFFFFF', fontSize: 9, fontFamily: 'Inter_700Bold', letterSpacing: 0.8 },
  thumbRow: { gap: 8, paddingHorizontal: 20, paddingTop: 12 },
  thumb: { width: 56, height: 56, borderRadius: 12, overflow: 'hidden' },
  thumbImage: { width: '100%', height: '100%' },
  iconButton: { position: 'absolute', left: 18, width: 42, height: 42, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 21 },
  detailTop: { flexDirection: 'row', gap: 12 },
  category: { fontSize: 10, fontFamily: 'Inter_700Bold', letterSpacing: 1.4 },
  title: { fontSize: 27, lineHeight: 31, fontFamily: 'Inter_700Bold', letterSpacing: -1, marginTop: 8 },
  subtitle: { fontSize: 13, fontFamily: 'Inter_400Regular', marginTop: 6 },
  rating: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingTop: 5 },
  ratingText: { fontSize: 13, fontFamily: 'Inter_700Bold' },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 19 },
  price: { fontSize: 23, fontFamily: 'Inter_700Bold' },
  originalPrice: { fontSize: 12, fontFamily: 'Inter_400Regular', textDecorationLine: 'line-through' },
  reviews: { paddingHorizontal: 8, paddingVertical: 5, borderRadius: 8, marginLeft: 'auto' },
  reviewsText: { fontSize: 10, fontFamily: 'Inter_600SemiBold' },
  description: { fontSize: 13, lineHeight: 20, fontFamily: 'Inter_400Regular', marginTop: 19 },
  optionLabel: { fontSize: 13, fontFamily: 'Inter_700Bold', marginTop: 26 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 11 },
  option: { minWidth: 54, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, borderWidth: 1, alignItems: 'center' },
  optionText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  qtyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 22 },
  qtyControls: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  qtyBtn: { width: 36, height: 36, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  qtyValue: { fontSize: 18, fontFamily: 'Inter_700Bold', minWidth: 28, textAlign: 'center' },
  delivery: { flexDirection: 'row', alignItems: 'center', gap: 11, padding: 13, borderRadius: 15, borderWidth: 1, marginTop: 26 },
  deliveryTitle: { fontSize: 12, fontFamily: 'Inter_700Bold' },
  deliveryBody: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 3 },
  bottomBar: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: 18, paddingTop: 12, borderTopWidth: 1 },
  addToCart: { height: 54, borderRadius: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 },
  addToCartText: { color: '#FFFFFF', fontSize: 14, fontFamily: 'Inter_700Bold' },
  addToCartPrice: { color: '#FFE4DA', fontSize: 12, fontFamily: 'Inter_600SemiBold', marginLeft: 4 },
});