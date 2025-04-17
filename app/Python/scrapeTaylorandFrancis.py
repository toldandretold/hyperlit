import markdownify

def convert_html_to_markdown():
    # Prompt the user to paste the HTML content
    print("Paste the HTML content below (press Enter twice to finish):")
    html_content = []
    while True:
        line = input()
        if line == "":
            break
        html_content.append(line)
    html_content = "\n".join(html_content)

    # Convert the HTML content to Markdown
    markdown_content = markdownify.markdownify(html_content, heading_style="ATX")

    # Save the Markdown content to a file
    output_file = "output.md"
    with open(output_file, "w", encoding="utf-8") as file:
        file.write(markdown_content)

    print(f"Markdown content saved to {output_file}")

# Call the function
convert_html_to_markdown()
