import requests
from bs4 import BeautifulSoup
import html2text
import re
from urllib.parse import urljoin
import time

class MarxCapitalScraper:
    def __init__(self, base_url):
        self.base_url = base_url
        self.converter = html2text.HTML2Text()
        self.converter.body_width = 0
        self.converter.ignore_links = False
        self.converter.ignore_images = True
        self.converter.ignore_emphasis = False
        self.session = requests.Session()

    def clean_content(self, content):
        # Remove unwanted sections
        unwanted_classes = ['toc', 'title', 'information', 'footer']
        for class_name in unwanted_classes:
            for element in content.find_all(class_=class_name):
                element.decompose()

        # Remove hr elements
        for hr in content.find_all('hr'):
            hr.decompose()

        # Remove navigation links at bottom
        for p in content.find_all('p'):
            if any(text in p.get_text().lower() for text in ['next:', 'previous:', 'index']):
                p.decompose()

        # Remove index sections that are part of TOC
        for element in content.find_all('p', class_='index'):
            if element.find('a', href=re.compile('^#')):
                element.decompose()

        return content

    def convert_footnotes(self, html_content):
        # Convert footnote references - all types
        html_content = re.sub(
            r'<sup class="enote"><a href="#(\d+)">\[\d+\]</a></sup>',
            lambda m: f'[^{m.group(1)}]',
            html_content
        )
        
        html_content = re.sub(
            r'<sup class="enote"><a href="#n(\d+)">\[\d+\]</a></sup>',
            lambda m: f'[^{m.group(1)}]',
            html_content
        )
        
        html_content = re.sub(
            r'<span class="note"><a href="#(\d+)">\[\d+\]</a></span>',
            lambda m: f'[^{m.group(1)}]',
            html_content
        )

        # Convert footnote definitions - all types
        html_content = re.sub(
            r'<span class="info"><a name="(\d+)" href="#\d+b">\d+\.</a></span>',
            lambda m: f'[^{m.group(1)}]: ',
            html_content
        )
        
        html_content = re.sub(
            r'<span class="info"><a href="#\d+b" name="n(\d+)">\d+\.</a></span>',
            lambda m: f'[^{m.group(1)}]: ',
            html_content
        )
        
        html_content = re.sub(
            r'<span class="note"><a href="#(\d+)b" name="\d+">\[\d+\]</a></span>',
            lambda m: f'[^{m.group(1)}]: ',
            html_content
        )

        return html_content




    def get_links_from_html(self, html_content):
        soup = BeautifulSoup(html_content, 'html.parser')
        links = []
        
        for p in soup.find_all('p', class_='index'):
            for a in p.find_all('a'):
                href = a.get('href')
                if href and not href.startswith(('http', 'index-l.htm')):
                    links.append(href)
        
        return links

    def get_preface_links_from_html(self, html_content):
        soup = BeautifulSoup(html_content, 'html.parser')
        links = []
        
        for li in soup.find_all('li'):
            a = li.find('a')
            if a and a.get('href'):
                links.append(a['href'])
        
        return links

    def scrape_page(self, url):
        print(f"Scraping: {url}")
        try:
            response = self.session.get(url)
            response.raise_for_status()
            
            soup = BeautifulSoup(response.text, 'html.parser')
            
            # Clean content before processing
            content = self.clean_content(soup)
            
            # Convert footnotes
            html_content = str(content)
            html_content = self.convert_footnotes(html_content)
            
            # Convert to markdown
            markdown_content = self.converter.handle(html_content)
            
            # Clean up the markdown
            markdown_content = re.sub(r'\n\n+', '\n\n', markdown_content)
            markdown_content = re.sub(r'\* \* \*\n*', '', markdown_content)
            markdown_content = re.sub(r'\[(Capital|Index|Next|Previous)[^\]]*\]\([^\)]*\)', '', markdown_content)
            markdown_content = markdown_content.strip()
            
            return markdown_content
            
        except Exception as e:
            print(f"Error scraping {url}: {str(e)}")
            return ""

    def scrape_capital(self, toc_html, prefaces_html):
        main_links = self.get_links_from_html(toc_html)
        preface_links = self.get_preface_links_from_html(prefaces_html)
        
        with open('Marx1867Capital.md', 'w', encoding='utf-8') as f:
            # Handle prefaces
            for link in preface_links:
                url = urljoin(self.base_url, link)
                content = self.scrape_page(url)
                if content:
                    f.write(content + '\n\n---\n\n')
                time.sleep(1)
            
            # Handle main chapters
            for link in main_links:
                url = urljoin(self.base_url, link)
                content = self.scrape_page(url)
                if content:
                    f.write(content + '\n\n---\n\n')
                time.sleep(1)

def main():
    # Your HTML content here as strings
    toc_html = """<div class="border">

<h4>Table of Contents</h4>

<p><img align="right" hspace="10" src="pics/cover.gif" alt="cover" border="0"></p>

<p class="index">
<a href="part0.htm">Prefaces and
Afterwords</a>
</p>


<p class="toc">
Part I: Commodities and Money</p>

<p class="index">
Ch. 1: <a href="ch01.htm">Commodities</a><br>
&nbsp; &nbsp; <span style="font-weight: normal;"><a href="commodity.htm">Ch. 1 as per First German Edition</a></span>
<br>
Ch. 2: <a href="ch02.htm">Exchange</a>
<br>
Ch. 3: <a href="ch03.htm">Money,
or the Circulation of Commodities</a>
</p>


<p class="toc">
Part II: The Transformation of Money into Capital</p>

<p class="index">
Ch. 4: <a href="ch04.htm">The
General Formula for Capital</a>
<br>
Ch. 5: <a href="ch05.htm">Contradictions
in the General Formula of Capital</a>
<br>
Ch. 6: <a href="ch06.htm">The
Buying and Selling of Labour-Power</a>
</p>


<p class="toc">
Part III: The Production of Absolute Surplus-Value</p>

<p class="index">
Ch. 7: <a href="ch07.htm">The
Labour-Process and the Process of Producing Surplus-Value</a>
<br>
Ch. 8: <a href="ch08.htm">Constant
Capital and Variable Capital</a>
<br>
Ch. 9: <a href="ch09.htm">The
Rate of Surplus-Value</a>
<br>
Ch. 10: <a href="ch10.htm">The
Working-Day</a>
<br>
Ch. 11: <a href="ch11.htm">Rate
and Mass of Surplus-Value</a>
</p>


<p class="toc">
Part IV: Production of Relative Surplus Value</p>

<p class="index">
Ch. 12: <a href="ch12.htm">The
Concept of Relative Surplus-Value</a>
<br>
Ch. 13: <a href="ch13.htm">Co-operation</a>
<br>
Ch. 14: <a href="ch14.htm">Division
of Labour and Manufacture</a>
<br>
Ch. 15: <a href="ch15.htm">Machinery
and Modern Industry</a>
</p>

<p class="toc">
Part V: The Production of Absolute and of Relative Surplus-Value</p>

<p class="index">
Ch. 16: <a href="ch16.htm">Absolute
and Relative Surplus-Value</a>
<br>
Ch. 17: <a href="ch17.htm">Changes
of Magnitude in the Price of Labour-Power and in Surplus-Value</a>
<br>
Ch. 18: <a href="ch18.htm">Various
Formula for the Rate of Surplus-Value</a>
</p>

<p class="toc">
Part VI: Wages</p>

<p class="index">
Ch. 19: <a href="ch19.htm">The Transformation of the Value (and Respective Price) of Labour-Power into Wages</a>
<br>
Ch. 20: <a href="ch20.htm">Time-Wages</a>
<br>
Ch. 21: <a href="ch21.htm">Piece-Wages</a>
<br>
Ch. 22: <a href="ch22.htm">National
Differences of Wages</a>
</p>


<p class="toc">
Part VII: The Accumulation of Capital</p>

<p class="index">
Ch. 23: <a href="ch23.htm">Simple
Reproduction</a>
<br>
Ch. 24: <a href="ch24.htm">Conversion
of Surplus-Value into Capital</a>
<br>
Ch. 25: <a href="ch25.htm">The
General Law of Capitalist Accumulation</a>
</p>


<p class="toc">
Part VIII: Primitive Accumulation</p>

<p class="index">
Ch. 26: <a href="ch26.htm">The
Secret of Primitive Accumulation</a>
<br>
Ch. 27: <a href="ch27.htm">Expropriation
of the Agricultural Population from the Land</a>
<br>
Ch. 28: <a href="ch28.htm">Bloody
Legislation against the Expropriated, from the End of the 15th Century.
Forcing down of Wages by Acts of Parliament</a>
<br>
Ch. 29: <a href="ch29.htm">Genesis
of the Capitalist Farmer</a>
<br>
Ch. 30: <a href="ch30.htm">Reaction
of the Agricultural Revolution on Industry. Creation of the Home-Market
for Industrial Capital</a>
<br>
Ch. 31: <a href="ch31.htm">Genesis
of the Industrial Capitalist</a>
<br>
Ch. 32: <a href="ch32.htm">Historical
Tendency of Capitalist Accumulation</a>
<br>
Ch. 33: <a href="ch33.htm">The
Modern Theory of Colonisation</a>
</p>

<p class="index">
Appendix to the First German Edition: <a href="appendix.htm">The Value-Form</a></p>

<p class="indentb">
See <a href="index-l.htm">Full table of contents listing</a>.</p>
<p class="indentb">
See <a href="http://www.mlwerke.de/me/me23/me23_000.htm" target="_top">original German language text</a> at <i>MLWerke</i>, and 
<a href="../1864/economic/index.htm">“Unpublished Sixth Chapter of <i>Capital</i>”</a></p>
 
<hr class="end">

<p class="footer">
Untermann translation: 
<a href="untermann/volume-1.pdf">Volume One</a> |
<a href="untermann/volume-2.pdf">Volume Two</a> |
<a href="untermann/volume-3.pdf">Volume Three</a></p>
<p class="footer">
<a href="../1885-c2/index.htm">Volume Two</a> |
<a href="../1894-c3/index.htm">Volume Three</a><br>

<a href="../../../../reference/subject/economics/index.htm">Political Economists</a> |
<a href="guide/index.htm">Study Guide</a> |
<a href="../1867/reviews-capital/index.htm">Reviews of Capital</a> |
<a href="../../index.htm">Marx/Engels Archive</a><br>
<a href="../subject/economy/index.htm">Economic Works</a> |
<a href="../../letters/subject/capital.htm">Letters on Capital</a>
</p>
</div>"""  # The first HTML chunk you provided
    prefaces_html = """<ul class="disc">
<li>1867: <a href="dedicate.htm">Dedication to Wilhelm Wolff</a></li>

<li>1867: <a href="p1.htm">Preface to the First German Edition</a> (Marx)</li>

<li>1872: <a href="p2.htm">Preface to the French Edition</a> (Marx)</li>

<li>1873: <a href="p3.htm">Afterword to the Second German Edition</a> (Marx)</li>

<li>1875: <a href="p4.htm">Afterword to the French Edition</a> (Marx)</li>

<li>1883: <a href="p5.htm">Preface to the Third German Edition</a> (Engels)</li>

<li>1886: <a href="p6.htm">Preface to the English Edition</a> (Engels)</li>

<li>1890: <a href="p7.htm">Preface to the Fourth German Edition</a> (Engels)</li>

<li>1867: <a href="letter.htm">Marx's thank you letter to Engels</a></li>
</ul>"""  # The second HTML chunk you provided
    
    base_url = "https://www.marxists.org/archive/marx/works/1867-c1/"
    scraper = MarxCapitalScraper(base_url)
    scraper.scrape_capital(toc_html, prefaces_html)
    print("Scraping completed. Output saved to Marx1867Capital.md")

if __name__ == "__main__":
    main()
