#!/usr/bin/env python3

import sys
import os
from bs4 import BeautifulSoup

def normalize_headings(html_file):
    """
    Normalizes heading hierarchy to eliminate gaps.
    E.g., if we have h1 -> h4, it converts h4 to h2.
    If we have h1 -> h2 -> h5, it converts h5 to h3.
    """
    
    # Read the HTML file
    with open(html_file, 'r', encoding='utf-8') as f:
        soup = BeautifulSoup(f.read(), 'html.parser')
    
    # Find all headings in document order
    headings = soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
    
    if not headings:
        print("No headings found in the document.")
        return
    
    print(f"Found {len(headings)} headings")
    
    # Track the current heading level and mapping
    current_level = 0
    level_mapping = {}
    changes_made = 0
    
    for heading in headings:
        # Get the current heading level (1-6)
        original_level = int(heading.name[1])
        
        # Determine what the new level should be
        if original_level == 1:
            # H1 always stays H1, reset hierarchy
            new_level = 1
            current_level = 1
        elif original_level <= current_level + 1:
            # Normal progression (same level or one level deeper)
            new_level = original_level
            current_level = max(current_level, original_level)
        else:
            # Gap detected! Normalize to current_level + 1
            new_level = current_level + 1
            current_level = new_level
        
        # Apply the change if needed
        if original_level != new_level:
            old_tag = heading.name
            heading.name = f'h{new_level}'
            print(f"Changed {old_tag} to h{new_level}: {str(heading)[:60]}...")
            changes_made += 1
        
        # Store mapping for reference
        if original_level not in level_mapping:
            level_mapping[original_level] = new_level
    
    print(f"\nHeading level mapping applied:")
    for orig, new in sorted(level_mapping.items()):
        if orig != new:
            print(f"  h{orig} -> h{new}")
        else:
            print(f"  h{orig} -> h{new} (unchanged)")
    
    print(f"\nTotal changes made: {changes_made}")
    
    if changes_made > 0:
        # Write the updated HTML back
        with open(html_file, 'w', encoding='utf-8') as f:
            f.write(str(soup))
        print(f"Updated file saved: {html_file}")
    else:
        print("No changes needed - heading hierarchy is already normalized.")

def analyze_headings(html_file):
    """
    Analyzes the current heading structure without making changes.
    """
    with open(html_file, 'r', encoding='utf-8') as f:
        soup = BeautifulSoup(f.read(), 'html.parser')
    
    headings = soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
    
    if not headings:
        print("No headings found in the document.")
        return
    
    print(f"Current heading structure ({len(headings)} headings):")
    print("-" * 50)
    
    current_level = 0
    issues = 0
    
    for i, heading in enumerate(headings):
        level = int(heading.name[1])
        indent = "  " * (level - 1)
        text = heading.get_text()[:50] + ("..." if len(heading.get_text()) > 50 else "")
        
        # Check for issues
        issue = ""
        if level > current_level + 1 and current_level > 0:
            issue = f" [GAP: should be h{current_level + 1}]"
            issues += 1
        
        print(f"{i+1:3d}. {indent}h{level}: {text}{issue}")
        current_level = max(current_level, level) if level != 1 else 1
    
    print("-" * 50)
    if issues > 0:
        print(f"Found {issues} heading hierarchy issues that need fixing.")
    else:
        print("Heading hierarchy looks good!")

if __name__ == '__main__':
    if len(sys.argv) != 3:
        print("Usage: python normalize_headings.py <analyze|fix> <html_file>")
        print("  analyze - Shows current heading structure and issues")
        print("  fix     - Normalizes heading hierarchy")
        sys.exit(1)
    
    action = sys.argv[1]
    html_file = sys.argv[2]
    
    if not os.path.exists(html_file):
        print(f"Error: File '{html_file}' not found.")
        sys.exit(1)
    
    if action == "analyze":
        analyze_headings(html_file)
    elif action == "fix":
        normalize_headings(html_file)
    else:
        print("Error: Action must be 'analyze' or 'fix'")
        sys.exit(1)