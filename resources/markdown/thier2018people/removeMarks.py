import re

def remove_tags(text):
    """
    Remove <mark> and <u> tags (including attributes) and their closing tags from the text.
    
    Parameters:
        text (str): The input text.
    
    Returns:
        str: The text with <mark> and <u> tags removed.
    """
    # This pattern matches opening and closing tags for both mark and u tags
    pattern = re.compile(r'</?(mark|u)\b[^>]*>', re.IGNORECASE)
    return re.sub(pattern, '', text)

def main():
    input_file = 'main-text.md'
    output_file = 'main-text-cleaned.md'
    
    try:
        with open(input_file, 'r', encoding='utf-8') as f:
            content = f.read()

        cleaned_content = remove_tags(content)
        
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write(cleaned_content)
        
        print(f"Cleaned file successfully saved to '{output_file}'.")
    
    except FileNotFoundError:
        print(f"Error: File '{input_file}' not found.")
    except Exception as e:
        print(f"An error occurred: {e}")

if __name__ == "__main__":
    main()
