package egovframework.shop.member.web;

import javax.annotation.Resource;
import org.springframework.stereotype.Controller;
import org.springframework.ui.ModelMap;
import org.springframework.web.bind.annotation.*;
import egovframework.shop.member.service.MemberService;
import egovframework.shop.member.service.MemberVO;

@Controller
@RequestMapping("/member")
public class MemberController {

    @Resource(name = "memberservice")
    private MemberService memberservice;

    /** 회원 목록 화면 */
    @RequestMapping("/memberList.do")
    public String memberList(@ModelAttribute("searchVO") MemberVO vo, ModelMap model) throws Exception {
        model.addAttribute("selectMemberList", memberservice.selectMemberList(vo));
        return "shop/member/memberList";
    }

    /** 회원 상세 화면 */
    @RequestMapping("/memberDetail.do")
    public String memberDetail(@ModelAttribute("searchVO") MemberVO vo, ModelMap model) throws Exception {
        model.addAttribute("selectMember", memberservice.selectMember(vo));
        model.addAttribute("selectMemberAddrList", memberservice.selectMemberAddrList(vo));
        return "shop/member/memberDetail";
    }

    /** 회원 상세: updateMemberGrade (ajax) */
    @RequestMapping(value = "/updateMemberGrade.do", method = RequestMethod.POST)
    @ResponseBody
    public java.util.Map<String, Object> updateMemberGrade(MemberVO vo) throws Exception {
        memberservice.updateMemberGrade(vo);
        return java.util.Collections.singletonMap("result", "OK");
    }

    /** 회원 등급 관리 화면 */
    @RequestMapping("/memberGradeList.do")
    public String memberGradeList(@ModelAttribute("searchVO") MemberVO vo, ModelMap model) throws Exception {
        model.addAttribute("selectGradeList", memberservice.selectGradeList(vo));
        return "shop/member/memberGradeList";
    }

    /** 회원 등급 관리: updateGrade (ajax) */
    @RequestMapping(value = "/updateGrade.do", method = RequestMethod.POST)
    @ResponseBody
    public java.util.Map<String, Object> updateGrade(MemberVO vo) throws Exception {
        memberservice.updateGrade(vo);
        return java.util.Collections.singletonMap("result", "OK");
    }

    /** 휴면 회원 목록 화면 */
    @RequestMapping("/dormantList.do")
    public String dormantList(@ModelAttribute("searchVO") MemberVO vo, ModelMap model) throws Exception {
        model.addAttribute("selectDormantList", memberservice.selectDormantList(vo));
        return "shop/member/dormantList";
    }

}
