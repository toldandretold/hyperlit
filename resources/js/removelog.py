import re

def remove_console_logs(js_file_path, output_file_path):
    with open(js_file_path, 'r', encoding='utf-8') as file:
        js_code = file.readlines()

    # Regex patterns to match console logs, warnings, and errors
    log_patterns = [
        r'^\s*console\.log\(.*\);\s*$',  # Matches single-line console.log()
        r'^\s*console\.warn\(.*\);\s*$',  # Matches single-line console.warn()
        r'^\s*console\.error\(.*\);\s*$',  # Matches single-line console.error()
    ]

    # Remove lines matching the patterns
    cleaned_code = []
    in_multiline_log = False

    for line in js_code:
        stripped_line = line.strip()

        # Detect multi-line `console.log(`
        if stripped_line.startswith("console.log(") or stripped_line.startswith("console.warn(") or stripped_line.startswith("console.error("):
            in_multiline_log = True

        # If inside a multi-line console log, ignore lines until we reach the closing `);`
        if in_multiline_log:
            if stripped_line.endswith(");"):
                in_multiline_log = False
            continue

        # Remove single-line console logs
        if any(re.match(pattern, stripped_line) for pattern in log_patterns):
            continue

        cleaned_code.append(line)

    # Save the cleaned file
    with open(output_file_path, 'w', encoding='utf-8') as file:
        file.writelines(cleaned_code)

    print(f"✅ All console logs removed. Cleaned file saved to: {output_file_path}")

# Usage Example
remove_console_logs('lazy-loading.js', 'lazy-loading-cleaned.js')
