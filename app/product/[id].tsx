import { Feather } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatPrice, getProductImages } from '@/data/store';
import { ProductImagePlaceholder } from '@/components/ProductImagePlaceholder';
import { useColors } from '@/hooks/useColors';
import { useStore } from '@/context/StoreContext';

export default function ProductDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { products, addToCart, isFavorite, toggleFavorite } = useStore();
  const product = products.find((item) => item.id === id) ?? products[0];
  const [selected, setSelected] = useState(product.sizes?.[1] ?? product.colors[0]);
  const images = getProductImages(product);
  const [activeImage, setActiveImage] = useState(0);

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 120 }}>
        <View style={styles.imageWrap}>
          {images.length ? (
            <Image source={images[Math.min(activeImage, images.length - 1)]} style={styles.image} />
          ) : (
            <ProductImagePlaceholder style={styles.image} iconSize={40} />
          )}
          <Pressable onPress={() => router.back()} style={[styles.iconButton, { backgroundColor: colors.card, top: insets.top + 10 }]}>
            <Feather name="arrow-left" size={20} color={colors.foreground} />
          </Pressable>
          <Pressable onPress={() => toggleFavorite(product.id)} style={[styles.iconButton, { backgroundColor: colors.card, top: insets.top + 10, right: 18 }]}>
            <Feather name="heart" size={19} color={isFavorite(product.id) ? colors.coral : colors.foreground} fill={isFavorite(product.id) ? colors.coral : 'transparent'} />
          </Pressable>
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
                <Image source={source} style={styles.thumbImage} />
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
        <View style={styles.content}>
          <View style={styles.detailTop}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.category, { color: colors.coral }]}>{product.category.toUpperCase()}</Text>
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
          onPress={() => addToCart(product, selected)}
          style={({ pressed }) => [
            styles.addToCart,
            { backgroundColor: product.inStock ? colors.coral : colors.muted, opacity: pressed ? 0.86 : 1 },
          ]}
          testID="add-to-cart"
        >
          <Feather name="shopping-bag" size={18} color={product.inStock ? '#FFFFFF' : colors.mutedForeground} />
          <Text style={[styles.addToCartText, !product.inStock && { color: colors.mutedForeground }]}>
            {product.inStock ? 'Add to cart' : 'Out of stock'}
          </Text>
          {product.inStock ? <Text style={styles.addToCartPrice}>{formatPrice(product.price)}</Text> : null}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  imageWrap: { height: 390, position: 'relative' },
  image: { width: '100%', height: '100%' },
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
  delivery: { flexDirection: 'row', alignItems: 'center', gap: 11, padding: 13, borderRadius: 15, borderWidth: 1, marginTop: 26 },
  deliveryTitle: { fontSize: 12, fontFamily: 'Inter_700Bold' },
  deliveryBody: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 3 },
  bottomBar: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: 18, paddingTop: 12, borderTopWidth: 1 },
  addToCart: { height: 54, borderRadius: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 },
  addToCartText: { color: '#FFFFFF', fontSize: 14, fontFamily: 'Inter_700Bold' },
  addToCartPrice: { color: '#FFE4DA', fontSize: 12, fontFamily: 'Inter_600SemiBold', marginLeft: 4 },
});