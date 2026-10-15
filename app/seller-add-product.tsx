import { Feather } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MAX_PRODUCT_IMAGES } from '@/constants/config';
import { computeDisplayPrice, formatPrice, MarkupType, NewProductInput } from '@/data/store';
import { isCloudinaryConfigured, uploadImageToCloudinary } from '@/services/cloudinary/upload';
import { useColors } from '@/hooks/useColors';
import { useStore } from '@/context/StoreContext';
import { showPlatformAlert } from '@/utils/platformDialogs';

type ImageSlot = {
  id: string;
  uri: string; // local file uri (new picks) or remote URL (already uploaded)
  publicId?: string; // set once uploaded to Cloudinary
  status: 'new' | 'uploading' | 'done' | 'error';
  progress: number;
  error?: string;
};

let slotCounter = 0;
const nextSlotId = () => `slot-${Date.now()}-${slotCounter++}`;

export default function SellerAddProductScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { products, categories, addProduct, updateProduct, isCloudMode } = useStore();
  const editing = useMemo(() => products.find((p) => p.id === id), [id, products]);

  const [images, setImages] = useState<ImageSlot[]>(() => {
    if (editing?.imageUrls?.length) {
      return editing.imageUrls.map((uri, i) => ({
        id: nextSlotId(),
        uri,
        publicId: editing.imagePublicIds?.[i],
        status: 'done' as const,
        progress: 100,
      }));
    }
    return [];
  });
  const [removedPublicIds, setRemovedPublicIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const [sourceUrl, setSourceUrl] = useState(editing?.sourceUrl ?? '');
  const [sourceCode, setSourceCode] = useState(editing?.sourceCode ?? '');
  const [name, setName] = useState(editing?.name ?? '');
  const [subtitle, setSubtitle] = useState(editing?.subtitle ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  // Category stored as a string — matches product.category which is now `string`
  const availableCategories = categories.filter((c) => c.enabled || editing?.category === c.id || editing?.category === c.name || editing?.category === c.slug);
  const defaultCategory = availableCategories[0]?.id ?? 'home';
  const [category, setCategory] = useState<string>(editing?.category ?? defaultCategory);
  const [baseCost, setBaseCost] = useState(editing ? String(editing.baseCost) : '');
  const [markupType, setMarkupType] = useState<MarkupType>(editing?.markupType ?? 'percent');
  const [markupValue, setMarkupValue] = useState(editing ? String(editing.markupValue) : '25');
  const [manualPrice, setManualPrice] = useState(
    editing?.manualPrice !== undefined
      ? String(editing.manualPrice)
      : editing?.markupType === 'manual'
      ? String(editing.price)
      : '',
  );
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [featured, setFeatured] = useState(editing?.featured ?? false);
  const [isNew, setIsNew] = useState(editing?.isNew ?? false);
  const [originalPrice, setOriginalPrice] = useState(editing?.originalPrice ? String(editing.originalPrice) : '');
  const [colorsInput, setColorsInput] = useState(editing?.colors?.join(', ') ?? '');
  const [sizesInput, setSizesInput] = useState(editing?.sizes?.join(', ') ?? '');

  const costNum = parseFloat(baseCost) || 0;
  const markupNum = parseFloat(markupValue) || 0;
  const manualNum = parseFloat(manualPrice);
  const isManualValid = Number.isFinite(manualNum) && manualNum >= 0;

  const previewPrice = computeDisplayPrice(
    costNum,
    markupType,
    markupNum,
    markupType === 'manual' ? (isManualValid ? manualNum : 0) : undefined,
  );
  const previewMargin = previewPrice - costNum;
  const isLoss = previewMargin < 0;

  const canSave =
    name.trim().length > 0 &&
    costNum > 0 &&
    (markupType === 'manual' ? isManualValid : true) &&
    !saving;

  const handlePasteUrl = () => {
    if (!sourceUrl.trim()) return;
    showPlatformAlert(
      'Manual import',
      "Live-scraping a Meesho page isn't safe or reliable from this app (ToS risk, and it breaks whenever the site changes). The link is saved for reference — fill in the title, images, and cost yourself below.",
    );
  };

  const pickImages = async () => {
    const remaining = MAX_PRODUCT_IMAGES - images.length;
    if (remaining <= 0) {
      showPlatformAlert('Limit reached', `A product can have a maximum of ${MAX_PRODUCT_IMAGES} photos.`);
      return;
    }
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      showPlatformAlert('Permission needed', 'Allow photo library access to select images.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
      allowsMultipleSelection: true,
      selectionLimit: remaining,
    });
    if (result.canceled || !result.assets?.length) return;
    const newSlots: ImageSlot[] = result.assets.slice(0, remaining).map((asset) => ({
      id: nextSlotId(),
      uri: asset.uri,
      status: 'new',
      progress: 0,
    }));
    setImages((current) => [...current, ...newSlots]);
  };

  const removeImage = (slot: ImageSlot) => {
    if (slot.publicId) setRemovedPublicIds((current) => [...current, slot.publicId!]);
    setImages((current) => current.filter((s) => s.id !== slot.id));
  };

  const moveImage = (index: number, direction: -1 | 1) => {
    setImages((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const [isUploadingAll, setIsUploadingAll] = useState(false);

  const retryImage = async (slot: ImageSlot, targetId?: string) => {
    const folderId = targetId || editing?.id || 'new';
    setImages((current) => current.map((s) => (s.id === slot.id ? { ...s, status: 'uploading', progress: 0, error: undefined } : s)));
    try {
      const { url, publicId } = await uploadImageToCloudinary(slot.uri, `vibekart/products/${folderId}`, (progress) =>
        setImages((current) => current.map((s) => (s.id === slot.id ? { ...s, progress } : s))),
      );
      setImages((current) => current.map((s) => (s.id === slot.id ? { ...s, uri: url, publicId, status: 'done', progress: 100 } : s)));
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Upload failed';
      setImages((current) =>
        current.map((s) => (s.id === slot.id ? { ...s, status: 'error', error: msg } : s)),
      );
      showPlatformAlert('Upload failed', msg);
    }
  };

  /** Uploads every slot that isn't already a `done` Cloudinary URL. */
  const uploadPendingImages = async (folderId: string): Promise<ImageSlot[]> => {
    let current = images;
    for (const slot of images) {
      if (slot.status === 'done') continue;
      setImages((prev) => prev.map((s) => (s.id === slot.id ? { ...s, status: 'uploading', progress: 0 } : s)));
      try {
        const { url, publicId } = await uploadImageToCloudinary(slot.uri, `vibekart/products/${folderId}`, (progress) =>
          setImages((prev) => prev.map((s) => (s.id === slot.id ? { ...s, progress } : s))),
        );
        current = current.map((s) => (s.id === slot.id ? { ...s, uri: url, publicId, status: 'done' as const, progress: 100 } : s));
        setImages(current);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Upload failed';
        current = current.map((s) =>
          s.id === slot.id ? { ...s, status: 'error' as const, error: msg } : s,
        );
        setImages(current);
      }
    }
    return current;
  };

  const handleManualUploadAll = async () => {
    if (!isCloudinaryConfigured) {
      showPlatformAlert(
        'Cloudinary not configured',
        'Please configure EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME and EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET to upload images.',
      );
      return;
    }
    const pendingSlots = images.filter((s) => s.status !== 'done');
    if (!pendingSlots.length) {
      showPlatformAlert('All uploaded', 'All selected images are already uploaded to Cloudinary.');
      return;
    }
    setIsUploadingAll(true);
    try {
      const folderId = editing?.id || 'new';
      const result = await uploadPendingImages(folderId);
      const failed = result.filter((s) => s.status === 'error').length;
      if (failed === 0) {
        showPlatformAlert('Upload successful', 'All photos were uploaded to Cloudinary successfully.');
      } else {
        showPlatformAlert('Partial upload', `${failed} photo(s) failed to upload. Check connection and tap Retry on the failed photos.`);
      }
    } finally {
      setIsUploadingAll(false);
    }
  };

  const handleSave = async () => {
    if (isCloudMode && !isCloudinaryConfigured && images.some((s) => s.status !== 'done')) {
      showPlatformAlert(
        'Cloudinary is not configured',
        "New photos can't be uploaded because Cloudinary environment variables are missing (EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME and EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET). Remove new photos to save without them, or configure Cloudinary first.",
      );
      return;
    }
    setSaving(true);
    try {
      const input: NewProductInput = {
        name: name.trim(),
        subtitle: subtitle.trim(),
        description: description.trim(),
        category,
        baseCost: costNum,
        markupType,
        markupValue: markupNum,
        manualPrice: markupType === 'manual' ? (isManualValid ? Math.round(manualNum) : undefined) : undefined,
        originalPrice: originalPrice ? parseFloat(originalPrice) : undefined,
        colors: colorsInput.split(',').map((c) => c.trim()).filter(Boolean),
        sizes: sizesInput.trim() ? sizesInput.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        sourceUrl: sourceUrl.trim() || undefined,
        sourceCode: sourceCode.trim() || undefined,
        enabled,
        featured,
        isNew,
      };

      const productId = editing ? editing.id : await addProduct(input);
      if (editing) await updateProduct(editing.id, input);

      let finalImages = images;
      if (isCloudMode && isCloudinaryConfigured && images.some((s) => s.status !== 'done')) {
        finalImages = await uploadPendingImages(productId);
      }

      const failedCount = finalImages.filter((s) => s.status === 'error').length;
      const successfulUrls = finalImages.filter((s) => s.status === 'done').map((s) => s.uri);
      const successfulPublicIds = finalImages.filter((s) => s.status === 'done').map((s) => s.publicId).filter(Boolean) as string[];

      if (isCloudMode) {
        await updateProduct(productId, { imageUrls: successfulUrls, imagePublicIds: successfulPublicIds });
        
      } else {
        // Local demo mode: no real cloud upload, just keep the picked local
        // URIs as the product's images so the feature still works offline.
        await updateProduct(productId, { imageUrls: images.map((s) => s.uri) });
      }

      if (failedCount > 0) {
        showPlatformAlert(
          'Product saved',
          `${failedCount} photo${failedCount > 1 ? 's' : ''} failed to upload. The rest of the product was saved — you can retry those photos from here.`,
        );
        setSaving(false);
        return;
      }

      router.back();
    } catch (error) {
      showPlatformAlert('Save failed', error instanceof Error ? error.message : 'Something went wrong. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingTop: insets.top + 14, paddingBottom: 140 }}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={[styles.backButton, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="x" size={19} color={colors.foreground} />
          </Pressable>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>{editing ? 'Edit product' : 'Add product'}</Text>
          <View style={{ width: 42 }} />
        </View>

        <View style={styles.form}>
          <Text style={[styles.sectionLabel, { color: colors.coral }]}>SUPPLIER REFERENCE (ADMIN ONLY)</Text>
          <Text style={[styles.label, { color: colors.foreground }]}>Meesho product URL</Text>
          <View style={styles.urlRow}>
            <TextInput
              value={sourceUrl}
              onChangeText={setSourceUrl}
              placeholder="https://www.meesho.com/s/p/..."
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="none"
              style={[styles.input, { flex: 1, backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
            />
            <Pressable onPress={handlePasteUrl} style={[styles.urlButton, { backgroundColor: colors.mossSoft }]}>
              <Feather name="link" size={16} color={colors.moss} />
            </Pressable>
          </View>
          <Text style={[styles.label, { color: colors.foreground }]}>Supplier SKU / order code (optional)</Text>
          <TextInput
            value={sourceCode}
            onChangeText={setSourceCode}
            placeholder="MSH-XXXX-001"
            placeholderTextColor={colors.mutedForeground}
            style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
          />

          <Text style={[styles.sectionLabel, { color: colors.coral, marginTop: 26 }]}>PRODUCT DETAILS</Text>
          <Text style={[styles.label, { color: colors.foreground }]}>Name</Text>
          <TextInput value={name} onChangeText={setName} placeholder="Terra Glow Lamp" placeholderTextColor={colors.mutedForeground} style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]} />
          <Text style={[styles.label, { color: colors.foreground }]}>Subtitle</Text>
          <TextInput value={subtitle} onChangeText={setSubtitle} placeholder="Warm light, slow evenings" placeholderTextColor={colors.mutedForeground} style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]} />
          <Text style={[styles.label, { color: colors.foreground }]}>Description</Text>
          <TextInput value={description} onChangeText={setDescription} multiline placeholder="Describe the product in a few lines" placeholderTextColor={colors.mutedForeground} style={[styles.input, styles.multiline, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]} />

          <View style={styles.photosHeader}>
            <Text style={[styles.label, { color: colors.foreground, marginTop: 0, marginBottom: 0 }]}>
              Photos ({images.length}/{MAX_PRODUCT_IMAGES})
            </Text>
            {!isCloudinaryConfigured && isCloudMode ? (
              <Text style={[styles.photosHint, { color: colors.coral }]}>Cloudinary not configured</Text>
            ) : null}
          </View>
          <Text style={[styles.photosSubhint, { color: colors.mutedForeground }]}>
            The first photo becomes the main/primary image — use the arrows to reorder.
          </Text>

          {!isCloudinaryConfigured && isCloudMode ? (
            <View style={[styles.configWarningBox, { backgroundColor: colors.coralSoft, borderColor: colors.coral }]}>
              <Feather name="alert-triangle" size={15} color={colors.coral} />
              <Text style={[styles.configWarningText, { color: colors.coral }]}>
                Cloudinary is not configured. Add EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME and EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET to your environment to enable cloud photo uploads.
              </Text>
            </View>
          ) : null}

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.photoRow}>
            {images.map((slot, index) => (
              <View key={slot.id} style={[styles.photoSlot, { borderColor: colors.border }]}>
                <Image source={{ uri: slot.uri }} style={styles.photoImage} />
                {index === 0 ? (
                  <View style={[styles.primaryBadge, { backgroundColor: colors.moss }]}>
                    <Text style={styles.primaryBadgeText}>PRIMARY</Text>
                  </View>
                ) : null}
                {slot.status === 'done' ? (
                  <View style={[styles.statusBadge, { backgroundColor: colors.moss }]}>
                    <Feather name="check" size={10} color="#FFFFFF" />
                  </View>
                ) : slot.status === 'new' ? (
                  <View style={[styles.statusBadge, { backgroundColor: colors.mutedForeground }]}>
                    <Text style={styles.statusBadgeText}>LOCAL</Text>
                  </View>
                ) : null}
                {slot.status === 'uploading' ? (
                  <View style={styles.photoOverlay}>
                    <ActivityIndicator color="#FFFFFF" />
                    <Text style={styles.photoOverlayText}>{slot.progress}%</Text>
                  </View>
                ) : null}
                {slot.status === 'error' ? (
                  <Pressable style={[styles.photoOverlay, { backgroundColor: 'rgba(217,85,85,0.85)' }]} onPress={() => retryImage(slot, editing?.id)}>
                    <Feather name="refresh-cw" size={16} color="#FFFFFF" />
                    <Text style={styles.photoOverlayText}>Retry</Text>
                  </Pressable>
                ) : null}
                <Pressable onPress={() => removeImage(slot)} style={[styles.photoRemove, { backgroundColor: colors.destructive }]}>
                  <Feather name="x" size={12} color="#FFFFFF" />
                </Pressable>
                <View style={styles.photoReorder}>
                  <Pressable disabled={index === 0} onPress={() => moveImage(index, -1)} style={[styles.reorderButton, index === 0 && { opacity: 0.3 }]}>
                    <Feather name="chevron-left" size={13} color="#FFFFFF" />
                  </Pressable>
                  <Pressable disabled={index === images.length - 1} onPress={() => moveImage(index, 1)} style={[styles.reorderButton, index === images.length - 1 && { opacity: 0.3 }]}>
                    <Feather name="chevron-right" size={13} color="#FFFFFF" />
                  </Pressable>
                </View>
              </View>
            ))}
            {images.length < MAX_PRODUCT_IMAGES ? (
              <Pressable onPress={pickImages} style={[styles.addPhotoSlot, { borderColor: colors.border, backgroundColor: colors.card }]}>
                <Feather name="plus" size={20} color={colors.mutedForeground} />
                <Text style={[styles.addPhotoText, { color: colors.mutedForeground }]}>Add</Text>
              </Pressable>
            ) : null}
          </ScrollView>

          {isCloudMode && isCloudinaryConfigured && images.some((s) => s.status !== 'done') ? (
            <Pressable
              disabled={isUploadingAll}
              onPress={handleManualUploadAll}
              style={[styles.uploadButton, { backgroundColor: colors.mossSoft, borderColor: colors.moss }]}
            >
              {isUploadingAll ? (
                <ActivityIndicator size="small" color={colors.moss} />
              ) : (
                <>
                  <Feather name="upload-cloud" size={15} color={colors.moss} />
                  <Text style={[styles.uploadButtonText, { color: colors.moss }]}>Upload selected photos to Cloudinary</Text>
                </>
              )}
            </Pressable>
          ) : null}

          <Text style={[styles.label, { color: colors.foreground }]}>Category</Text>
          <View style={styles.chipRow}>
            {availableCategories.map((cat) => {
              const isSelected = category === cat.id || category === cat.name || category === cat.slug;
              return (
                <Pressable
                  key={cat.id}
                  onPress={() => setCategory(cat.id)}
                  style={[styles.chip, { backgroundColor: isSelected ? colors.moss : colors.card, borderColor: isSelected ? colors.moss : colors.border }]}
                >
                  <Text style={[styles.chipText, { color: isSelected ? '#FFFFFF' : colors.foreground }]}>{cat.name}</Text>
                </Pressable>
              );
            })}
          </View>
          <Pressable onPress={() => router.push('/seller-categories' as any)} hitSlop={8} style={{ marginTop: 6 }}>
            <Text style={{ fontSize: 11, color: colors.moss, fontFamily: 'Inter_500Medium' }}>+ Manage categories</Text>
          </Pressable>

          <Text style={[styles.label, { color: colors.foreground }]}>Colours / variants (comma separated)</Text>
          <TextInput value={colorsInput} onChangeText={setColorsInput} placeholder="Clay, Sand" placeholderTextColor={colors.mutedForeground} style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]} />
          <Text style={[styles.label, { color: colors.foreground }]}>Sizes (optional, comma separated)</Text>
          <TextInput value={sizesInput} onChangeText={setSizesInput} placeholder="S, M, L, XL" placeholderTextColor={colors.mutedForeground} style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]} />

          <Text style={[styles.sectionLabel, { color: colors.coral, marginTop: 26 }]}>PRICE ENGINE</Text>
          <Text style={[styles.label, { color: colors.foreground }]}>Base cost (Meesho price) ₹</Text>
          <TextInput value={baseCost} onChangeText={setBaseCost} keyboardType="numeric" placeholder="950" placeholderTextColor={colors.mutedForeground} style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]} />

          <Text style={[styles.label, { color: colors.foreground }]}>Markup type</Text>
          <View style={styles.chipRow}>
            {(['fixed', 'percent', 'manual'] as MarkupType[]).map((type) => (
              <Pressable
                key={type}
                onPress={() => setMarkupType(type)}
                style={[styles.chip, { backgroundColor: markupType === type ? colors.moss : colors.card, borderColor: markupType === type ? colors.moss : colors.border }]}
              >
                <Text style={[styles.chipText, { color: markupType === type ? '#FFFFFF' : colors.foreground }]}>
                  {type === 'fixed' ? 'Fixed ₹' : type === 'percent' ? 'Percent %' : 'Manual ₹'}
                </Text>
              </Pressable>
            ))}
          </View>

          {markupType === 'manual' ? (
            <>
              <Text style={[styles.label, { color: colors.foreground }]}>Target selling price ₹</Text>
              <TextInput
                value={manualPrice}
                onChangeText={setManualPrice}
                keyboardType="numeric"
                placeholder="1499"
                placeholderTextColor={colors.mutedForeground}
                style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
              />
              {manualPrice.trim().length > 0 && !isManualValid ? (
                <Text style={{ fontSize: 11, color: colors.destructive, marginTop: 4 }}>
                  Enter a valid non-negative number for the selling price
                </Text>
              ) : null}
            </>
          ) : (
            <>
              <Text style={[styles.label, { color: colors.foreground }]}>
                Markup value {markupType === 'percent' ? '(%)' : '(₹)'}
              </Text>
              <TextInput
                value={markupValue}
                onChangeText={setMarkupValue}
                keyboardType="numeric"
                placeholder={markupType === 'percent' ? '25' : '150'}
                placeholderTextColor={colors.mutedForeground}
                style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
              />
            </>
          )}

          <Text style={[styles.label, { color: colors.foreground }]}>Strike-through original price (optional) ₹</Text>
          <TextInput value={originalPrice} onChangeText={setOriginalPrice} keyboardType="numeric" placeholder="1999" placeholderTextColor={colors.mutedForeground} style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]} />

          {isLoss && costNum > 0 ? (
            <View style={[styles.lossWarning, { backgroundColor: colors.coralSoft, borderColor: colors.destructive }]}>
              <Feather name="alert-triangle" size={16} color={colors.destructive} />
              <Text style={[styles.lossWarningText, { color: colors.destructive }]}>
                Selling price ({formatPrice(previewPrice)}) is below supplier cost ({formatPrice(costNum)}). You will make a negative margin of {formatPrice(previewMargin)} per unit.
              </Text>
            </View>
          ) : null}

          <View style={[styles.previewCard, { backgroundColor: isLoss ? colors.coralSoft : colors.mossSoft }]}>
            <View>
              <Text style={[styles.previewLabel, { color: isLoss ? colors.destructive : colors.moss }]}>CUSTOMER SEES</Text>
              <Text style={[styles.previewPrice, { color: isLoss ? colors.destructive : colors.moss }]}>{formatPrice(previewPrice)}</Text>
            </View>
            <View>
              <Text style={[styles.previewLabel, { color: isLoss ? colors.destructive : colors.moss }]}>YOUR MARGIN</Text>
              <Text style={[styles.previewPrice, { color: isLoss ? colors.destructive : colors.moss }]}>{formatPrice(previewMargin)}</Text>
            </View>
          </View>

          <Text style={[styles.sectionLabel, { color: colors.coral, marginTop: 26 }]}>VISIBILITY & FLAGS</Text>
          <View style={[styles.switchRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.switchTitle, { color: colors.foreground }]}>Active in storefront</Text>
              <Text style={[styles.switchSubtitle, { color: colors.mutedForeground }]}>
                When turned off, customers cannot view or purchase this product
              </Text>
            </View>
            <Switch
              value={enabled}
              onValueChange={setEnabled}
              trackColor={{ false: colors.border, true: colors.mossSoft }}
              thumbColor={enabled ? colors.moss : colors.mutedForeground}
            />
          </View>

          <View style={[styles.switchRow, { backgroundColor: colors.card, borderColor: colors.border, marginTop: 10 }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.switchTitle, { color: colors.foreground }]}>Featured pick</Text>
              <Text style={[styles.switchSubtitle, { color: colors.mutedForeground }]}>
                Highlight this product in Explore and curated edits
              </Text>
            </View>
            <Switch
              value={featured}
              onValueChange={setFeatured}
              trackColor={{ false: colors.border, true: colors.coralSoft }}
              thumbColor={featured ? colors.coral : colors.mutedForeground}
            />
          </View>

          <View style={[styles.switchRow, { backgroundColor: colors.card, borderColor: colors.border, marginTop: 10 }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.switchTitle, { color: colors.foreground }]}>Badge as "NEW"</Text>
              <Text style={[styles.switchSubtitle, { color: colors.mutedForeground }]}>
                Displays a prominent "NEW" badge on product cards
              </Text>
            </View>
            <Switch
              value={isNew}
              onValueChange={setIsNew}
              trackColor={{ false: colors.border, true: colors.mossSoft }}
              thumbColor={isNew ? colors.moss : colors.mutedForeground}
            />
          </View>
        </View>
      </ScrollView>
      <View style={[styles.bottomBar, { backgroundColor: colors.background, borderTopColor: colors.border, paddingBottom: Math.max(insets.bottom, 14) }]}>
        <Pressable
          disabled={!canSave}
          onPress={handleSave}
          style={[styles.saveButton, { backgroundColor: canSave ? colors.coral : colors.muted }]}
          testID="save-product"
        >
          {saving ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={[styles.saveText, { color: canSave ? '#FFFFFF' : colors.mutedForeground }]}>
              {editing ? 'Save changes' : 'Add to catalogue'}
            </Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18 },
  backButton: { width: 42, height: 42, borderRadius: 15, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 16, fontFamily: 'Inter_700Bold' },
  form: { paddingHorizontal: 20, marginTop: 10 },
  sectionLabel: { fontSize: 10, fontFamily: 'Inter_700Bold', letterSpacing: 1.3, marginTop: 6 },
  label: { fontSize: 12, fontFamily: 'Inter_700Bold', marginTop: 14, marginBottom: 8 },
  input: { minHeight: 48, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, fontSize: 13, fontFamily: 'Inter_400Regular' },
  multiline: { minHeight: 80, paddingTop: 12, textAlignVertical: 'top' },
  urlRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  urlButton: { width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, borderWidth: 1 },
  chipText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  photosHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 },
  photosHint: { fontSize: 10, fontFamily: 'Inter_700Bold' },
  photosSubhint: { fontSize: 10, fontFamily: 'Inter_400Regular', marginTop: 4, marginBottom: 10 },
  photoRow: { gap: 10, paddingVertical: 2 },
  photoSlot: { width: 92, height: 92, borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  photoImage: { width: '100%', height: '100%' },
  primaryBadge: { position: 'absolute', bottom: 4, left: 4, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  primaryBadgeText: { color: '#FFFFFF', fontSize: 7, fontFamily: 'Inter_700Bold' },
  statusBadge: { position: 'absolute', top: 4, left: 4, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 5, alignItems: 'center', justifyContent: 'center' },
  statusBadgeText: { color: '#FFFFFF', fontSize: 7, fontFamily: 'Inter_700Bold' },
  photoOverlay: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', gap: 4 },
  photoOverlayText: { color: '#FFFFFF', fontSize: 10, fontFamily: 'Inter_700Bold' },
  photoRemove: { position: 'absolute', top: 4, right: 4, width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  photoReorder: { position: 'absolute', bottom: 4, right: 4, flexDirection: 'row', gap: 3 },
  reorderButton: { width: 18, height: 18, borderRadius: 9, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
  addPhotoSlot: { width: 92, height: 92, borderRadius: 14, borderWidth: 1, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', gap: 4 },
  addPhotoText: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  configWarningBox: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: 13, borderWidth: 1, marginBottom: 10 },
  configWarningText: { flex: 1, fontSize: 11, fontFamily: 'Inter_500Medium', lineHeight: 15 },
  uploadButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 42, borderRadius: 12, borderWidth: 1, marginTop: 10 },
  uploadButtonText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  previewCard: { flexDirection: 'row', justifyContent: 'space-between', borderRadius: 17, padding: 16, marginTop: 24 },
  previewLabel: { fontSize: 9, fontFamily: 'Inter_700Bold', letterSpacing: 1 },
  previewPrice: { fontSize: 20, fontFamily: 'Inter_700Bold', marginTop: 4 },
  lossWarning: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: 14, borderWidth: 1, marginTop: 18 },
  lossWarningText: { flex: 1, fontSize: 12, fontFamily: 'Inter_500Medium', lineHeight: 16 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14, borderWidth: 1, borderRadius: 16 },
  switchTitle: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  switchSubtitle: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 3 },
  bottomBar: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: 18, paddingTop: 13, borderTopWidth: 1 },
  saveButton: { height: 54, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  saveText: { fontSize: 14, fontFamily: 'Inter_700Bold' },
});
