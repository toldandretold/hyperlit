import fitz  # PyMuPDF

# Specify the input PDF file and the output Markdown file
input_pdf = "king2019imperialism.pdf"  # Replace with the name of your PDF file
output_md = "main-text.md"    # Replace with the name of your desired Markdown file

# Open the PDF file
try:
    pdf_document = fitz.open(input_pdf)
except Exception as e:
    print(f"Error opening file: {e}")
    exit()

# Prepare to write text to the Markdown file
try:
    with open(output_md, "w", encoding="utf-8") as md_file:
        # Iterate through all pages and extract text
        for page_number in range(len(pdf_document)):
            page = pdf_document[page_number]
            text = page.get_text()  # Extract text from the page
            
            # Write the page content to the Markdown file
         # Markdown header for the page
            md_file.write(text + "\n\n")
        
        print(f"Text successfully extracted to {output_md}")

except Exception as e:
    print(f"Error writing to file: {e}")
finally:
    # Close the PDF document
    pdf_document.close()
