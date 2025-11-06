import { describe, it, expect, beforeEach } from 'vitest';
import { SelectionManager } from '../../../resources/js/editToolbar/selectionManager.js';

describe('SelectionManager', () => {
  let manager;

  beforeEach(() => {
    // Clear document and create fresh manager for each test
    document.body.innerHTML = '';
    manager = null;
  });

  // ===== Constructor and Initialization =====
  describe('constructor', () => {
    it('initializes with default options', () => {
      manager = new SelectionManager();

      expect(manager.editableSelector).toBe(".main-content[contenteditable='true']");
      expect(manager.isMobile).toBe(false);
      expect(manager.isVisible).toBe(false);
      expect(manager.currentSelection).toBe(null);
      expect(manager.lastValidRange).toBe(null);
    });

    it('accepts custom editableSelector', () => {
      manager = new SelectionManager({
        editableSelector: '.custom-editor',
      });

      expect(manager.editableSelector).toBe('.custom-editor');
    });

    it('creates mobile backup properties when isMobile is true', () => {
      manager = new SelectionManager({ isMobile: true });

      expect(manager.isMobile).toBe(true);
      expect(manager.mobileBackupRange).toBe(null);
      expect(manager.mobileBackupText).toBe('');
      expect(manager.mobileBackupContainer).toBe(null);
    });

    it('does not create mobile backup properties when isMobile is false', () => {
      manager = new SelectionManager({ isMobile: false });

      expect(manager.mobileBackupRange).toBeUndefined();
      expect(manager.mobileBackupText).toBeUndefined();
      expect(manager.mobileBackupContainer).toBeUndefined();
    });

    it('accepts isVisible option', () => {
      manager = new SelectionManager({ isVisible: true });

      expect(manager.isVisible).toBe(true);
    });

    it('binds handleSelectionChange method', () => {
      manager = new SelectionManager();

      // Method should be bound (not lose context when called)
      expect(typeof manager.handleSelectionChange).toBe('function');
    });
  });

  // ===== Visibility Management =====
  describe('setVisible', () => {
    it('updates visibility state to true', () => {
      manager = new SelectionManager();

      manager.setVisible(true);
      expect(manager.isVisible).toBe(true);
    });

    it('updates visibility state to false', () => {
      manager = new SelectionManager({ isVisible: true });

      manager.setVisible(false);
      expect(manager.isVisible).toBe(false);
    });

    it('can toggle visibility multiple times', () => {
      manager = new SelectionManager();

      manager.setVisible(true);
      expect(manager.isVisible).toBe(true);

      manager.setVisible(false);
      expect(manager.isVisible).toBe(false);

      manager.setVisible(true);
      expect(manager.isVisible).toBe(true);
    });
  });

  // ===== Selection Parent Element =====
  describe('getSelectionParentElement', () => {
    it('returns null when no current selection', () => {
      manager = new SelectionManager();

      const parent = manager.getSelectionParentElement();
      expect(parent).toBe(null);
    });

    it('returns element when parent is an element node', () => {
      manager = new SelectionManager();

      // Create a selection
      document.body.innerHTML = '<div><p id="test">Hello world</p></div>';
      const p = document.getElementById('test');
      const textNode = p.firstChild;

      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, 5);

      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);

      manager.currentSelection = selection;

      const parent = manager.getSelectionParentElement();
      expect(parent).toBe(p);
    });
  });

  // ===== getWorkingSelection =====
  describe('getWorkingSelection', () => {
    it('returns selection and range objects', () => {
      manager = new SelectionManager();

      const result = manager.getWorkingSelection();

      expect(result).toHaveProperty('selection');
      expect(result).toHaveProperty('range');
    });

    it('returns window selection when no stored selection', () => {
      manager = new SelectionManager();

      const result = manager.getWorkingSelection();

      // Should return current window selection
      expect(result.selection).toBe(window.getSelection());
    });

    it('can return null range when no selection made', () => {
      manager = new SelectionManager();

      // Clear any existing selection
      window.getSelection().removeAllRanges();

      const result = manager.getWorkingSelection();

      expect(result.range).toBe(null);
    });
  });

  // ===== storeSelectionForTouch =====
  describe('storeSelectionForTouch', () => {
    it('stores lastValidRange from current selection', () => {
      manager = new SelectionManager();

      document.body.innerHTML = '<div><p>Hello world</p></div>';
      const p = document.querySelector('p');
      const textNode = p.firstChild;

      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, 5);

      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);

      manager.storeSelectionForTouch('test-button');

      expect(manager.lastValidRange).not.toBe(null);
      expect(manager.lastValidRange.toString()).toBe('Hello');
    });

    it('does not crash when no selection exists', () => {
      manager = new SelectionManager();

      window.getSelection().removeAllRanges();

      // Should not throw
      expect(() => {
        manager.storeSelectionForTouch('test-button');
      }).not.toThrow();
    });
  });

  // ===== State Management =====
  describe('state management', () => {
    it('maintains separate currentSelection and lastValidRange', () => {
      manager = new SelectionManager();

      expect(manager.currentSelection).toBe(null);
      expect(manager.lastValidRange).toBe(null);

      // These should be independent
      manager.currentSelection = window.getSelection();
      expect(manager.lastValidRange).toBe(null);
    });

    it('preserves mobile backup state across operations', () => {
      manager = new SelectionManager({ isMobile: true });

      manager.mobileBackupText = 'test text';
      expect(manager.mobileBackupText).toBe('test text');

      // Should persist even after other operations
      manager.setVisible(true);
      expect(manager.mobileBackupText).toBe('test text');
    });
  });
});
