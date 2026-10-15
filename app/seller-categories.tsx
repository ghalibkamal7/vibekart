import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getAssignedProductCount, validateCategoryName } from '@/data/store';
import { confirmPlatformAction, showPlatformAlert } from '@/utils/platformDialogs';
import { useColors } from '@/hooks/useColors';
import { useStore } from '@/context/StoreContext';

export default function SellerCategoriesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { categories, products, addCategory, updateCategory, deleteCategory, toggleCategoryEnabled } = useStore();

  const [newName, setNewName] = useState('');
  const [newNameError, setNewNameError] = useState<string | null>(null);
  const [newNameSuccess, setNewNameSuccess] = useState<string | null>(null);
  const [addingBusy, setAddingBusy] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Editing state: tracks which category is being renamed inline
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [editingError, setEditingError] = useState<string | null>(null);

  const handleAdd = async () => {
    if (addingBusy) return;
    const result = validateCategoryName(newName, categories);
    if (!result.valid) {
      setNewNameError(result.error ?? 'Invalid name');
      return;
    }
    setNewNameError(null);
    setNewNameSuccess(null);
    setAddingBusy(true);
    try {
      const categoryName = newName.trim();
      await addCategory({ name: categoryName });
      setNewName('');
      setNewNameSuccess(`"${categoryName}" was added.`);
    } catch (err) {
      setNewNameError(err instanceof Error ? err.message : 'Failed to add category');
    } finally {
      setAddingBusy(false);
    }
  };

  const startEdit = (id: string, currentName: string) => {
    setEditingId(id);
    setEditingName(currentName);
    setEditingError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingName('');
    setEditingError(null);
  };

  const commitEdit = async (id: string) => {
    const result = validateCategoryName(editingName, categories, id);
    if (!result.valid) {
      setEditingError(result.error ?? 'Invalid name');
      return;
    }
    setEditingError(null);
    try {
      await updateCategory(id, { name: editingName.trim() });
      cancelEdit();
    } catch (err) {
      setEditingError(err instanceof Error ? err.message : 'Failed to rename');
    }
  };

  const handleDelete = (id: string, name: string) => {
    const count = getAssignedProductCount(
      categories.find((c) => c.id === id)!,
      products,
    );
    if (count > 0) {
      showPlatformAlert(
        'Cannot delete category',
        `"${name}" has ${count} product${count > 1 ? 's' : ''} assigned to it. Reassign or delete those products first, then try again.`,
      );
      return;
    }
    confirmPlatformAction(
      'Delete category?',
      `"${name}" will be permanently removed. Products are not affected.`,
      'Delete',
      async () => {
        try {
          await deleteCategory(id);
        } catch (err) {
          showPlatformAlert('Delete failed', err instanceof Error ? err.message : 'Something went wrong');
        }
      },
      true,
    );
  };

  const handleToggleEnabled = async (id: string) => {
    if (togglingId) return;
    setTogglingId(id);
    setCategoryError(null);
    try {
      await toggleCategoryEnabled(id);
    } catch (err) {
      setCategoryError(err instanceof Error ? err.message : 'Failed to toggle category status.');
    } finally {
      setTogglingId(null);
    }
  };

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={[styles.container, { paddingTop: insets.top + 14, paddingBottom: 100 }]}
    >
      {/* Header */}
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={[styles.backButton, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          <Feather name="arrow-left" size={19} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Categories</Text>
        <View style={{ width: 42 }} />
      </View>

      <Text style={[styles.kicker, { color: colors.coral }]}>MANAGE CATEGORIES</Text>
      <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
        Add, rename, or disable categories. You cannot delete a category while products are assigned to it.
      </Text>

      {/* Add new category form */}
      <View style={[styles.addCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.addLabel, { color: colors.foreground }]}>New category</Text>
        <View style={styles.addRow}>
          <TextInput
            value={newName}
            onChangeText={(text) => {
              setNewName(text);
              if (newNameError) setNewNameError(null);
              if (newNameSuccess) setNewNameSuccess(null);
            }}
            placeholder="e.g. Electronics"
            placeholderTextColor={colors.mutedForeground}
            maxLength={30}
            style={[
              styles.addInput,
              {
                backgroundColor: colors.background,
                borderColor: newNameError ? colors.destructive : colors.border,
                color: colors.foreground,
              },
            ]}
          />
          <Pressable
            onPress={handleAdd}
            disabled={addingBusy || !newName.trim()}
            style={[
              styles.addButton,
              { backgroundColor: !newName.trim() || addingBusy ? colors.muted : colors.moss },
            ]}
          >
            <Feather name="plus" size={18} color="#FFFFFF" />
          </Pressable>
        </View>
        {newNameError ? (
          <Text style={[styles.errorText, { color: colors.destructive }]}>{newNameError}</Text>
        ) : null}
        {newNameSuccess ? (
          <Text style={[styles.errorText, { color: colors.moss }]}>{newNameSuccess}</Text>
        ) : null}
      </View>

      {/* Category list */}
      <Text style={[styles.sectionTitle, { color: colors.foreground }]}>
        Catalogue ({categories.length})
      </Text>
      {categoryError ? (
        <Text style={[styles.errorText, { color: colors.destructive }]}>{categoryError}</Text>
      ) : null}

      {categories.map((cat) => {
        const count = getAssignedProductCount(cat, products);
        const isEditing = editingId === cat.id;

        return (
          <View key={cat.id} style={[styles.catRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[styles.catIcon, { backgroundColor: cat.enabled ? colors.mossSoft : colors.muted }]}>
              <Feather
                name={(cat.icon ?? 'tag') as keyof typeof Feather.glyphMap}
                size={16}
                color={cat.enabled ? colors.moss : colors.mutedForeground}
              />
            </View>

            <View style={{ flex: 1 }}>
              {isEditing ? (
                <>
                  <TextInput
                    value={editingName}
                    onChangeText={(text) => {
                      setEditingName(text);
                      if (editingError) setEditingError(null);
                    }}
                    maxLength={30}
                    autoFocus
                    style={[
                      styles.editInput,
                      {
                        backgroundColor: colors.background,
                        borderColor: editingError ? colors.destructive : colors.moss,
                        color: colors.foreground,
                      },
                    ]}
                  />
                  {editingError ? (
                    <Text style={[styles.errorText, { color: colors.destructive }]}>{editingError}</Text>
                  ) : null}
                  <View style={styles.editActions}>
                    <Pressable
                      onPress={() => commitEdit(cat.id)}
                      style={[styles.editBtn, { backgroundColor: colors.moss }]}
                    >
                      <Feather name="check" size={13} color="#FFFFFF" />
                      <Text style={styles.editBtnText}>Save</Text>
                    </Pressable>
                    <Pressable
                      onPress={cancelEdit}
                      style={[styles.editBtn, { backgroundColor: colors.muted }]}
                    >
                      <Feather name="x" size={13} color={colors.foreground} />
                      <Text style={[styles.editBtnText, { color: colors.foreground }]}>Cancel</Text>
                    </Pressable>
                  </View>
                </>
              ) : (
                <>
                  <Text style={[styles.catName, { color: cat.enabled ? colors.foreground : colors.mutedForeground }]}>
                    {cat.name}
                  </Text>
                  <Text style={[styles.catMeta, { color: colors.mutedForeground }]}>
                    {count} product{count !== 1 ? 's' : ''} · slug: {cat.slug}
                  </Text>
                </>
              )}
            </View>

            <View style={styles.catActions}>
              {/* Enabled toggle */}
              <View style={{ alignItems: 'center' }}>
                <Text style={{ fontSize: 8, fontFamily: 'Inter_600SemiBold', color: colors.mutedForeground, marginBottom: 2 }}>
                  {cat.enabled ? 'Active' : 'Off'}
                </Text>
                <Switch
                  value={cat.enabled}
                  disabled={!!togglingId}
                  onValueChange={() => handleToggleEnabled(cat.id)}
                  trackColor={{ false: colors.border, true: colors.mossSoft }}
                  thumbColor={cat.enabled ? colors.moss : colors.mutedForeground}
                />
              </View>

              {/* Edit button */}
              {!isEditing ? (
                <Pressable onPress={() => startEdit(cat.id, cat.name)} hitSlop={8} style={{ marginTop: 8 }}>
                  <Feather name="edit-3" size={16} color={colors.moss} />
                </Pressable>
              ) : null}

              {/* Delete button */}
              <Pressable onPress={() => handleDelete(cat.id, cat.name)} hitSlop={8} style={{ marginTop: 10 }}>
                <Feather name="trash-2" size={16} color={count > 0 ? colors.mutedForeground : colors.destructive} />
              </Pressable>
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 18 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  backButton: {
    width: 42,
    height: 42,
    borderRadius: 15,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  kicker: { fontSize: 10, fontFamily: 'Inter_700Bold', letterSpacing: 1.7, marginTop: 30 },
  subtitle: { fontSize: 12, lineHeight: 18, fontFamily: 'Inter_400Regular', marginTop: 6, marginBottom: 20 },
  addCard: {
    borderRadius: 17,
    borderWidth: 1,
    padding: 14,
    marginBottom: 22,
  },
  addLabel: { fontSize: 12, fontFamily: 'Inter_600SemiBold', marginBottom: 8 },
  addRow: { flexDirection: 'row', gap: 8 },
  addInput: {
    flex: 1,
    height: 42,
    borderRadius: 11,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
  },
  addButton: {
    width: 42,
    height: 42,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionTitle: { fontSize: 19, fontFamily: 'Inter_700Bold', marginBottom: 10 },
  catRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 11,
    borderRadius: 17,
    borderWidth: 1,
    padding: 12,
    marginBottom: 9,
  },
  catIcon: {
    width: 39,
    height: 39,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  catName: { fontSize: 13, fontFamily: 'Inter_700Bold' },
  catMeta: { fontSize: 10, fontFamily: 'Inter_400Regular', marginTop: 3 },
  editInput: {
    height: 36,
    borderRadius: 9,
    borderWidth: 1.5,
    paddingHorizontal: 10,
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
  },
  editActions: { flexDirection: 'row', gap: 6, marginTop: 6 },
  editBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  editBtnText: { color: '#FFFFFF', fontSize: 11, fontFamily: 'Inter_700Bold' },
  catActions: { alignItems: 'center' },
  errorText: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 4 },
});
