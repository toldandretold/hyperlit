can you please write me a python script which will parse a md file "details.md", get each url in the file, and use it to search through the url column of two .csv files (until the url is found, or log that it wasn't). the csv files are calld: fsb.csv and fso.csv. they are similar but not exaclty the same. 

when the url is matched, the details for that row should be extracted and pasted into a new "bookDraft.md" file. 

the title should be pasted as h1: "# {title content}" 

followed by the subheading content (if there is one) as h2: "## {subheading content}"

then Author in bold: "**{author content}** 

followed by: a markdown link to the URL itself, with format [*Freedom Socialist Organiser*](url) if the url was found in fso.csv, or [*Freedom Socialist Bulletin*](url) if it was found in fsb.csv. 

then there should be the {date content} | Issue {issue number content}

then the "content" column should be pasted, followed by "---"

as an example:

# Title of article
## Subtitle of article
**Author Jones**, [*Freedom Socialist Organiser*](https://socialism.com/fso-article/crush-fascism-before-it-grows-vital-lessons-from-the-past/), October 2015. 

The md content.

Has several paragraphs.

--- 